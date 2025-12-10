import assert from "assert";
import {
    NodeManagerClient,
    RemoteNodeInfo,
    RemotePeerExtra,
    RemotePeerInfo,
} from "./nodemanager-client";
import { ConfigStore, LocalUnderlayState, NodeSettings } from "./config-store";
import {
    checkedCallOutput,
    EnsureIPForward,
    EnsureNetNs,
    EnsureTempDir,
    nsWrap,
    resolveEndpoint,
    simpleCall,
    StopSystemdServiceBestEffort,
    sudoCall,
    sudoCallOutput,
    withDefaultNumber,
    ZeroableString,
} from "./utils";
import {
    EnsureIPTables,
    GetAllIPTablesRules,
    tryAppendIptablesRule,
    tryCheckIptablesRule,
    tryDeleteIptablesRule,
} from "./iptables";
import { logger } from "./common";
import {
    AssignWireGuardDevice,
    CreateVethDevice,
    CreateWireGuardDevice,
    DumpAllWireGuardState,
    GetInterfaceState,
    InterfaceState,
    tryDestroyDevice,
    UpWireGuardDevice,
} from "./device";
import { StartGostTLSRelayClient } from "external-tools";

async function tryPatchMTU(namespace: string) {
    const { code, stderr } = await simpleCall(
        nsWrap(namespace, [
            "iptables",
            "-C",
            "FORWARD",
            "-p",
            "tcp",
            "--tcp-flags",
            "SYN,RST",
            "SYN",
            "-j",
            "TCPMSS",
            "--clamp-mss-to-pmtu",
        ])
    );
    if (code !== 0) {
        if (
            stderr.includes(
                "iptables: Bad rule (does a matching rule exist in that chain?)"
            ) ||
            stderr.includes("iptables: No chain/target/match by that name")
        ) {
            logger.info(`Adding TCPMSS rule...`);
            await sudoCall(
                nsWrap(namespace, [
                    "iptables",
                    "-A",
                    "FORWARD",
                    "-p",
                    "tcp",
                    "--tcp-flags",
                    "SYN,RST",
                    "SYN",
                    "-j",
                    "TCPMSS",
                    "--clamp-mss-to-pmtu",
                ])
            );
        }
    }
}

async function generateNewWireGuardKeyPair() {
    const call1 = await checkedCallOutput(["wg", "genkey"]);
    const privateKey = call1.trim();
    const call2 = await simpleCall(
        ["wg", "pubkey"],
        Buffer.from(privateKey, "utf-8")
    );
    const publicKey = call2.stdout.trim();
    return { privateKey, publicKey };
}

export class ControlAgent {
    constructor(
        private store: ConfigStore,
        private client: NodeManagerClient
    ) {}

    async doSyncWireGuardKeys(atLeast: number): Promise<void> {
        const keys = await this.store.getAllWireGuardKeys();
        if (keys.length < atLeast) {
            logger.info(
                `${keys.length} WireGuard keys found, ${atLeast - keys.length} more needed, generating...`
            );
            for (let i = keys.length; i < atLeast; i++) {
                const { privateKey, publicKey } =
                    await generateNewWireGuardKeyPair();
                await this.store.createWireGuardKey(privateKey, publicKey);
            }

            return await this.doSyncWireGuardKeys(atLeast);
        }

        await this.client.syncWireGuardKeys(keys.map((k) => k.public));
    }

    async doSyncExitNode(
        nodeSettings: NodeSettings,
        remoteConfig: RemoteNodeInfo
    ) {
        const isExitNode = await tryCheckIptablesRule(
            "nat",
            `${nodeSettings.namespace}-POSTROUTING`,
            ["-o", nodeSettings.ethName, "-j", "MASQUERADE"]
        );
        if (!isExitNode && remoteConfig.exitNode) {
            logger.info(`Configuring as exit node...`);
            await tryAppendIptablesRule(
                "nat",
                `${nodeSettings.namespace}-POSTROUTING`,
                ["-o", nodeSettings.ethName, "-j", "MASQUERADE"]
            );
        } else if (isExitNode && !remoteConfig.exitNode) {
            logger.info(`Removing exit node configuration...`);
            await tryDeleteIptablesRule(
                "nat",
                `${nodeSettings.namespace}-POSTROUTING`,
                ["-o", nodeSettings.ethName, "-j", "MASQUERADE"]
            );
        }
    }

    async doSyncVeth(nodeSettings: NodeSettings, remoteConfig: RemoteNodeInfo) {
        let state: InterfaceState | undefined = undefined;
        try {
            state = await GetInterfaceState(
                nodeSettings.namespace,
                `${nodeSettings.namespace}-veth0`
            );
        } catch (e) {
            console.error(e);
        }

        if (state !== undefined && remoteConfig.vethCIDR === undefined) {
            logger.info(`Removing veth interface...`);
            await tryDestroyDevice("", `${nodeSettings.namespace}-veth0`);
            const rules = await GetAllIPTablesRules();
            const natRules = rules.get("nat");
            if (natRules !== undefined) {
                for (const rule of natRules) {
                    if (
                        rule.includes(
                            `${nodeSettings.namespace}-POSTROUTING`
                        ) &&
                        rule.includes("#local_veth#")
                    ) {
                        logger.info(`Removing iptables rule: ${rule}`);
                        const parts = rule.split(" ").slice(2);
                        await tryDeleteIptablesRule(
                            "nat",
                            `${nodeSettings.namespace}-POSTROUTING`,
                            parts
                        );
                    }
                }
            }

            const filterRules = rules.get("filter");
            if (filterRules !== undefined) {
                for (const rule of filterRules) {
                    if (
                        rule.includes(`${nodeSettings.namespace}-FORWARD`) &&
                        rule.includes("#local_veth#")
                    ) {
                        logger.info(`Removing iptables rule: ${rule}`);
                        const parts = rule.split(" ").slice(2);
                        await tryDeleteIptablesRule(
                            "filter",
                            `${nodeSettings.namespace}-FORWARD`,
                            parts
                        );
                    }

                    if (
                        rule.includes(`${nodeSettings.namespace}-INPUT`) &&
                        rule.includes("#local_veth#")
                    ) {
                        logger.info(`Removing iptables rule: ${rule}`);
                        const parts = rule.split(" ").slice(2);
                        await tryDeleteIptablesRule(
                            "filter",
                            `${nodeSettings.namespace}-INPUT`,
                            parts
                        );
                    }
                }
            }

            return;
        }

        if (state === undefined && remoteConfig.vethCIDR !== undefined) {
            logger.info(`Creating veth interface...`);
            await CreateVethDevice(
                nodeSettings.namespace,
                `${nodeSettings.namespace}-veth`,
                remoteConfig.vethCIDR
            );
            await tryAppendIptablesRule(
                "nat",
                `${nodeSettings.namespace}-POSTROUTING`,
                [
                    "-s",
                    remoteConfig.vethCIDR,
                    "-d",
                    remoteConfig.vethCIDR,
                    "-o",
                    `${nodeSettings.namespace}-veth0`,
                    "-j",
                    "ACCEPT",
                    "-m",
                    "comment",
                    "--comment",
                    "#local_veth#",
                ]
            );

            // TODO: dummy nic SNAT?
            const ethState = await GetInterfaceState("", nodeSettings.ethName);
            const snatIP = ethState.address;
            assert(
                snatIP !== undefined,
                `Failed to get IP address of interface ${nodeSettings.ethName}`
            );
            await tryAppendIptablesRule(
                "nat",
                `${nodeSettings.namespace}-POSTROUTING`,
                [
                    "!",
                    "-d",
                    "224.0.0.0/4",
                    "-o",
                    `${nodeSettings.namespace}-veth0`,
                    "-j",
                    "SNAT",
                    "--to",
                    snatIP,
                    "-m",
                    "comment",
                    "--comment",
                    "#local_veth#",
                ]
            );
            await tryAppendIptablesRule(
                "filter",
                `${nodeSettings.namespace}-FORWARD`,
                [
                    "-o",
                    `${nodeSettings.namespace}-veth0`,
                    "-j",
                    "ACCEPT",
                    "-m",
                    "comment",
                    "--comment",
                    "#local_veth#",
                ]
            );
            await tryAppendIptablesRule(
                "filter",
                `${nodeSettings.namespace}-INPUT`,
                [
                    "-p",
                    "ospf",
                    "-j",
                    "ACCEPT",
                    "-m",
                    "comment",
                    "--comment",
                    "#local_veth#",
                ]
            );
        }
    }

    async doSyncRemoveLocalUnderlay(ifname: string, state: LocalUnderlayState) {
        logger.info(
            `Removing underlay worker ${state.unit_name} for interface ${ifname}...`
        );
        await StopSystemdServiceBestEffort(`${state.unit_name}.service`);
        await this.store.deleteLocalUnderlayState(ifname);
    }

    async doSyncCreateLocalUnderlay(
        nodeSettings: NodeSettings,
        remotePeer: RemotePeerInfo,
        ifname: string
    ) {
        const remoteUnderlay = remotePeer.extra?.underlay;
        assert(remoteUnderlay !== undefined, "remoteUnderlay is undefined");
        switch (remoteUnderlay.provider) {
            case "gost_relay_client": {
                let serverIP = remoteUnderlay.config_gost_relay_client.server_addr;
                if (serverIP === undefined || serverIP === "") {
                    serverIP = (await resolveEndpoint(remotePeer.endpoint)).host;
                }

                logger.info(
                    `Starting gost relay client for interface ${ifname} to ${serverIP}:${remoteUnderlay.config_gost_relay_client.server_port}...`
                );
                const unitName = `networktools-${nodeSettings.namespace}-worker-${crypto.randomUUID()}`;
                await StartGostTLSRelayClient()
            }
        }
    }

    async doSyncPeerUnderlay(nodeSettings: NodeSettings, peer: RemotePeerInfo) {
        const ifname = `${nodeSettings.namespace}-${peer.id}`;
        const localUnderlayState =
            await this.store.getLocalUnderlayState(ifname);
        const remoteUnderlay = peer.extra?.underlay;

        if (localUnderlayState === undefined && remoteUnderlay === undefined) {
            // no underlay
            return;
        }

        if (localUnderlayState === undefined && remoteUnderlay !== undefined) {
            // need to create underlay worker
        }
    }

    async doSyncPeers(
        nodeSettings: NodeSettings,
        remotePeers: RemotePeerInfo[]
    ) {
        const localWGKeys = await this.store.getAllWireGuardKeys();
        const localWGKeyMap = new Map(
            localWGKeys.map((kp) => [kp.public, kp.private])
        ); // public -> private
        const localWGStates = await DumpAllWireGuardState(
            nodeSettings.namespace
        );
        const markedLocalStates = new Set<string>();
        for (const peer of remotePeers) {
            const ifname = `${nodeSettings.namespace}-${peer.id}`;
            const localState = localWGStates.get(ifname);

            if (localState === undefined) {
                logger.info(`Creating WireGuard peer interface ${ifname}...`);
                const privateKey = localWGKeyMap.get(peer.peerPublicKey);
                assert(
                    privateKey !== undefined,
                    `No local WireGuard key for public key ${peer.peerPublicKey} used in peer ${peer.id}`
                );
                await CreateWireGuardDevice(
                    nodeSettings.namespace,
                    ifname,
                    peer.addressCIDR,
                    withDefaultNumber(peer.mtu, 1420)
                );
                await AssignWireGuardDevice(nodeSettings.namespace, ifname, {
                    private: privateKey,
                    listenPort: peer.listenPort,
                    peerPublic: peer.peerPublicKey,
                    endpoint: peer.endpoint,
                    keepalive: peer.keepalive,
                    allowedIPs: "0.0.0.0/0",
                });
                await UpWireGuardDevice(nodeSettings.namespace, ifname);

                if (peer.listenPort !== 0) {
                    logger.info(
                        `WireGuard peer ${ifname} has listen port ${peer.listenPort}, adding iptables rule...`
                    );
                    await tryAppendIptablesRule(
                        "filter",
                        `${nodeSettings.namespace}-INPUT`,
                        [
                            "-p",
                            "udp",
                            "--dport",
                            `${peer.listenPort}`,
                            "-j",
                            "ACCEPT",
                            "-m",
                            "comment",
                            "--comment",
                            `#peer_${ifname}#`,
                        ]
                    );
                }

                if (peer.extra?.underlay !== undefined) {
                    await this.doSyncPeerUnderlay(nodeSettings, peer);
                }

                continue;
            }

            markedLocalStates.add(ifname);
            // compare local state and remote state
            logger.info(
                `WireGuard peer interface ${ifname} exists, checking...`
            );
            await this.doSyncPeerUnderlay(nodeSettings, peer);
            if (peer.extra?.underlay !== undefined) {
            }
        }

        for (const ifname of localWGStates.keys()) {
            if (markedLocalStates.has(ifname)) {
                continue;
            }

            logger.info(`Removing stale WireGuard peer interface ${ifname}...`);
            await tryDestroyDevice(nodeSettings.namespace, ifname);

            const rules = await GetAllIPTablesRules();
            const filterRules = rules.get("filter");
            if (filterRules !== undefined) {
                for (const rule of filterRules) {
                    if (
                        rule.includes(`${nodeSettings.namespace}-INPUT`) &&
                        rule.includes(`#peer_${ifname}#`)
                    ) {
                        logger.info(`Removing iptables rule: ${rule}`);
                        const parts = rule.split(" ").slice(2);
                        await tryDeleteIptablesRule(
                            "filter",
                            `${nodeSettings.namespace}-INPUT`,
                            parts
                        );
                    }
                }
            }
        }
    }

    async doSync() {
        const nodeSettings = await this.store.getNodeSettings();
        assert(nodeSettings !== undefined, "Node settings not configured");
        await EnsureNetNs(nodeSettings.namespace);
        await EnsureIPTables(nodeSettings.namespace);
        await EnsureIPForward(nodeSettings.namespace);
        await EnsureTempDir(nodeSettings.namespace);
        await tryPatchMTU(nodeSettings.namespace);

        // sync keys
        logger.info(`Sync keys...`);
        await this.doSyncWireGuardKeys(20);

        logger.info(`Sync node config...`);
        const remoteConfig = await this.client.getNodeConfig();
        const remotePeers = await this.client.getPeers();

        logger.info(
            `Fetched RemoteNodeConfig: ${JSON.stringify(remoteConfig)} PeerConfig: ${JSON.stringify(remotePeers)}`
        );

        await this.doSyncExitNode(nodeSettings, remoteConfig);
        await this.doSyncVeth(nodeSettings, remoteConfig);
        await this.doSyncPeers(remotePeers);
    }
}
