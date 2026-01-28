import assert from "node:assert";
import fsPromise from "node:fs/promises";
import {
    NodeManagerClient,
    NodeRouterInfo,
    RemoteNodeInfo,
    RemotePeerInfo,
} from "./nodemanager-client";
import { ConfigStore, LocalUnderlayState, NodeSettings } from "./config-store";
import {
    checkedCallOutput,
    formatTempDirPath,
    formatUnitname,
    isEmptyString,
    nsWrap,
    resolveEndpoint,
    simpleCall,
    StopSystemdServiceBestEffort,
    sudoCall,
    withDefaultNumber,
} from "./utils";
import {
    EnsureIPForward,
    EnsureNetNs,
    EnsureRouterContainer,
    EnsureTempDir,
} from "./ensures";
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
    DumpWireGuardState,
    GetInterfaceState,
    InterfaceState,
    tryDestroyDevice,
    UpWireGuardDevice,
    WireGuardState,
} from "./device";
import {
    StartGostTLSRelayClient,
    StartGostTLSRelayServer,
} from "./external-tools";
import { GetInstallDir } from "./config";
import { CalculateMultiplePings, PingRunner } from "./ping";
import { BFDConfig, CommonOSPFConfig, formatBirdConfig } from "./bird";
import { inspectRouterContainer } from "./podman";
import { GetRouterOSPFState, RouterInfo } from "./bird-ospf";
import { parseIPAddr } from "./ip-addr";

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

function routerInfoToNodeRouterInfo(routerInfo: RouterInfo): NodeRouterInfo {
    return {
        router_id: routerInfo.routerId,
        distance: routerInfo.distance,
        vlinks: routerInfo.vlinks.map((vl) => ({
            router_id: vl.routerId,
            metric: vl.metric,
        })),
        routers: routerInfo.routers.map((r) => ({
            router_id: r.routerId,
            metric: r.metric,
        })),
        stubnets: routerInfo.stubnets,
        xnetworks: routerInfo.xnetworks,
        xrouters: routerInfo.xrouters.map((xr) => ({
            router_id: xr.routerId,
            metric: xr.metric,
        })),
        externals: routerInfo.externals.map((ex) => ({
            network: ex.network,
            metric: ex.metric,
            metric_type: ex.metricType,
            tag: ex.tag,
            via: ex.via,
        })),
        nssa_externals: routerInfo.nssaExternals.map((nex) => ({
            network: nex.network,
            metric: nex.metric,
            metric_type: nex.metricType,
            tag: nex.tag,
            via: nex.via,
        })),
    };
}

export class ControlAgent {
    private store: ConfigStore;
    private client: NodeManagerClient;
    private pingRunnerMap: Map<string, { runner: PingRunner; pings: number[] }>;

    constructor(store: ConfigStore, client: NodeManagerClient) {
        this.store = store;
        this.client = client;
        this.pingRunnerMap = new Map();
    }

    async doSyncWireGuardKeys(atLeast: number): Promise<void> {
        const keys = this.store.getAllWireGuardKeys();
        if (keys.length < atLeast) {
            logger.info(
                `${keys.length} WireGuard keys found, ${atLeast - keys.length} more needed, generating...`
            );
            for (let i = keys.length; i < atLeast; i++) {
                const { privateKey, publicKey } =
                    await generateNewWireGuardKeyPair();
                this.store.createWireGuardKey(privateKey, publicKey);
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
                "",
                `${nodeSettings.namespace}-veth0`
            );
        } catch (e) {
            console.error(e);
        }

        if (state !== undefined && isEmptyString(remoteConfig.vethCIDR)) {
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

        if (state === undefined && !isEmptyString(remoteConfig.vethCIDR)) {
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
            const snatIP = ethState.addrInfo4?.address;
            assert(snatIP !== undefined, "addressMinusSuffix is undefined");

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
        this.store.deleteLocalUnderlayState(ifname);
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
                const remoteGostClientConfig =
                    remoteUnderlay.config_gost_relay_client;
                let serverIP = remoteGostClientConfig.server_addr;
                if (isEmptyString(serverIP)) {
                    serverIP = (await resolveEndpoint(remotePeer.endpoint))
                        .host;
                }

                logger.info(
                    `Starting gost relay client for interface ${ifname} to ${serverIP}:${remoteGostClientConfig.server_port}...`
                );
                const unitName = formatUnitname(
                    nodeSettings.namespace,
                    "worker"
                );
                await StartGostTLSRelayClient(unitName, GetInstallDir(), {
                    listenPort: remoteGostClientConfig.listen_port,
                    dstHost: serverIP,
                    dstPort: remoteGostClientConfig.server_port,
                    udpTTL: 120,
                });

                this.store.setLocalUnderlayState(ifname, {
                    unit_name: unitName,
                    mode: "client",
                    listen_port: remoteGostClientConfig.listen_port,
                    server_ip: serverIP,
                    server_port: remoteGostClientConfig.server_port,
                });

                // Set wireguard endpoint to gost listener
                await AssignWireGuardDevice(nodeSettings.namespace, ifname, {
                    peerPublic: remotePeer.publicKey,
                    endpoint: `127.0.0.1:${remoteGostClientConfig.listen_port}`,
                });
                return;
            }

            case "gost_relay_server": {
                const remoteGostServerConfig =
                    remoteUnderlay.config_gost_relay_server;
                const wgState = await DumpWireGuardState(
                    nodeSettings.namespace,
                    ifname
                );
                logger.info(
                    `Starting gost relay server for interface ${ifname}, accepting on port ${remoteGostServerConfig.listen_port} to 127.0.0.1:${wgState.listen}...`
                );
                const unitName = formatUnitname(
                    nodeSettings.namespace,
                    "worker"
                );
                await StartGostTLSRelayServer(unitName, GetInstallDir(), {
                    listenPort: remoteGostServerConfig.listen_port,
                    targetPort: wgState.listen,
                });
                this.store.setLocalUnderlayState(ifname, {
                    unit_name: unitName,
                    mode: "server",
                    listen_port: remoteGostServerConfig.listen_port,
                });
                return;
            }
        }
    }

    async doSyncPeerUnderlay(nodeSettings: NodeSettings, peer: RemotePeerInfo) {
        const ifname = `${nodeSettings.namespace}-${peer.id}`;
        const localUnderlayState = this.store.getLocalUnderlayState(ifname);
        const remoteUnderlay = peer.extra?.underlay;

        if (localUnderlayState === undefined && remoteUnderlay === undefined) {
            // no underlay
            return;
        }

        if (localUnderlayState === undefined && remoteUnderlay !== undefined) {
            // no underlay -> has underlay
            await this.doSyncCreateLocalUnderlay(nodeSettings, peer, ifname);
            return;
        }

        if (localUnderlayState !== undefined && remoteUnderlay === undefined) {
            // has underlay -> no underlay
            await this.doSyncRemoveLocalUnderlay(ifname, localUnderlayState);
            return;
        }

        assert(
            localUnderlayState !== undefined,
            "localUnderlayState is undefined (unlikely, bug)"
        );
        assert(
            remoteUnderlay !== undefined,
            "remoteUnderlay is undefined (unlikely, bug)"
        );

        // both have underlay, check configs
        let needRecreate = false;
        if (
            localUnderlayState.mode === "client" &&
            remoteUnderlay.provider === "gost_relay_client"
        ) {
            if (
                localUnderlayState.listen_port !==
                    remoteUnderlay.config_gost_relay_client.listen_port ||
                localUnderlayState.server_port !==
                    remoteUnderlay.config_gost_relay_client.server_port ||
                (!isEmptyString(
                    remoteUnderlay.config_gost_relay_client.server_addr
                ) &&
                    localUnderlayState.server_ip !==
                        remoteUnderlay.config_gost_relay_client.server_addr)
            ) {
                // config changed
                logger.info(
                    `Underlay config changed for interface ${ifname}, need recreate. Local: ${JSON.stringify(localUnderlayState)} Remote: ${JSON.stringify(remoteUnderlay)}`
                );
                needRecreate = true;
            }
        } else if (
            localUnderlayState.mode === "server" &&
            remoteUnderlay.provider === "gost_relay_server"
        ) {
            if (
                localUnderlayState.listen_port !==
                remoteUnderlay.config_gost_relay_server.listen_port
            ) {
                // config changed
                logger.info(
                    `Underlay config changed for interface ${ifname}, need recreate. Local: ${JSON.stringify(localUnderlayState)} Remote: ${JSON.stringify(remoteUnderlay)}`
                );
                needRecreate = true;
            }
        } else {
            // mode changed
            logger.info(
                `Underlay mode changed for interface ${ifname}, need recreate. Local: ${JSON.stringify(localUnderlayState)} Remote: ${JSON.stringify(remoteUnderlay)}`
            );
            needRecreate = true;
        }

        if (needRecreate) {
            await this.doSyncRemoveLocalUnderlay(ifname, localUnderlayState);
            await this.doSyncCreateLocalUnderlay(nodeSettings, peer, ifname);
        }
    }

    async doSyncPeerEndpoint(
        nodeSettings: NodeSettings,
        peer: RemotePeerInfo,
        ifname: string,
        localState: WireGuardState
    ) {
        const peerPublicKey = Object.keys(localState.peers)[0];
        const localPeerState = localState.peers[peerPublicKey];
        if (localPeerState.keepalive !== peer.keepalive) {
            await sudoCall(
                nsWrap(nodeSettings.namespace, [
                    "wg",
                    "set",
                    ifname,
                    "peer",
                    peerPublicKey,
                    "persistent-keepalive",
                    `${peer.keepalive}`,
                ])
            );
        }
    }

    async doSyncPeers(
        nodeSettings: NodeSettings,
        remotePeers: RemotePeerInfo[]
    ) {
        const localWGKeys = this.store.getAllWireGuardKeys();
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
                const privateKey = localWGKeyMap.get(peer.publicKey);
                assert(
                    privateKey !== undefined,
                    `No local WireGuard key for public key ${peer.publicKey} used in peer ${peer.id}`
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
            if (peer.extra?.underlay === undefined) {
                // underlay is synced now, and remote does not have underlay, try syncing endpoints.
                await this.doSyncPeerEndpoint(
                    nodeSettings,
                    peer,
                    ifname,
                    localState
                );
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

    async doSyncBird(
        nodeSettings: NodeSettings,
        remoteConfig: RemoteNodeInfo,
        remotePeers: RemotePeerInfo[]
    ) {
        // peers have been synced, so any peer in remotePeers now should be on this node
        const localInterfaceCIDRs = remotePeers.map((p) => {
            const addr = parseIPAddr(p.addressCIDR);
            assert(
                addr.subnetMask !== 32,
                "peer address has incorrect /32 subnet mask"
            );
            const startAddress = parseIPAddr(
                addr.native.startAddress().address
            );
            return `${startAddress.address}/${addr.subnetMask}`;
        });
        const costMap = new Map<string, number>();
        const toPingInterfaces: string[] = [];
        for (const peer of remotePeers) {
            const ifname = `${nodeSettings.namespace}-${peer.id}`;
            if (peer.extra?.ospf?.ping) {
                toPingInterfaces.push(ifname);
            }
        }
        const pingResultMap = await CalculateMultiplePings(
            nodeSettings.namespace,
            toPingInterfaces
        );
        for (const peer of remotePeers) {
            const ifname = `${nodeSettings.namespace}-${peer.id}`;
            let cost = peer.extra?.ospf?.cost ?? 1000;
            const offset = peer.extra?.ospf?.offset ?? 0;
            if (pingResultMap.has(ifname)) {
                cost = pingResultMap.get(ifname)!;
            }
            costMap.set(ifname, Math.min(Math.max(1, cost + offset), 65535));
        }

        const ospfAreaConfig: Record<
            string,
            Record<string, CommonOSPFConfig>
        > = {
            "0": {},
        };
        const bfdConfig: Record<string, BFDConfig> = {};

        for (const peer of remotePeers) {
            const ifname = `${nodeSettings.namespace}-${peer.id}`;
            let useCost = costMap.get(ifname);
            if (useCost === undefined || !Number.isFinite(useCost)) {
                useCost = 1000;
            } else {
                useCost = Math.floor(useCost);
            }

            ospfAreaConfig["0"][ifname] = {
                area: 0,
                cost: useCost,
                type: "ptp",
                // auth: ...
            };
            bfdConfig[ifname] = {
                intervalMs: 1000,
                // txMs
                // rxMs
                idleMs: 5000,
                multiplier: 5,
            };
        }

        // maybe have local networks?
        if (
            remoteConfig.vethCIDR !== undefined &&
            remoteConfig.ospf !== undefined
        ) {
            const areaId = `${remoteConfig.ospf.area}`;
            ospfAreaConfig[areaId] = {};
            const vethName = `${nodeSettings.namespace}-veth1`;
            ospfAreaConfig[areaId][vethName] = {
                area: remoteConfig.ospf.area,
                cost: remoteConfig.ospf.cost,
                auth: remoteConfig.ospf.auth,
                type: "ptp",
            };
        }

        const birdConfig = formatBirdConfig({
            directInterfaceNames: [],
            ospfImportExcludeCIDRs: localInterfaceCIDRs,
            ospfExportExcludeCIDRs: [],
            ospfAreaConfig,
            bfdConfig,
        });

        const tempFilePath = `/tmp/${crypto.randomUUID()}`;
        await fsPromise.writeFile(tempFilePath, birdConfig);
        console.info(`Temp bird config file created at: ${tempFilePath}`);
        const targetFilePath = `${formatTempDirPath(nodeSettings.namespace)}/router/bird.conf`;
        await sudoCall(["mv", tempFilePath, targetFilePath]);

        const containerId = await EnsureRouterContainer(nodeSettings.namespace);
        console.log(
            `Reload bird config for namespace ${nodeSettings.namespace} in container ${containerId}...`
        );
        await sudoCall(["podman", "exec", containerId, "birdc", "configure"]);
        console.log(
            `Bird config reloaded for namespace ${nodeSettings.namespace}`
        );
    }

    async collectTelemetry(
        nodeSettings: NodeSettings,
        remotePeers: RemotePeerInfo[]
    ) {
        const localWGStates = await DumpAllWireGuardState(
            nodeSettings.namespace
        );
        const filteredPeers = remotePeers
            .map((peer) => {
                const ifname = `${nodeSettings.namespace}-${peer.id}`;
                const localState = localWGStates.get(ifname);
                if (localState !== undefined) {
                    return {
                        id: peer.id,
                        ifname,
                        localState,
                    };
                }
            })
            .filter((p) => p !== undefined);

        const pingResultMap = await CalculateMultiplePings(
            nodeSettings.namespace,
            filteredPeers.map((p) => p.ifname)
        );

        const telemetryLinks = filteredPeers.map((p) => {
            const peerState = Object.values(p.localState.peers)[0];
            return {
                id: p.id,
                ping: pingResultMap.get(p.ifname) ?? -1, // for compatibility with python version
                rx: peerState.rx,
                tx: peerState.tx,
            };
        });
        await this.client.sendLinkTelemetry(telemetryLinks);

        const containerStatus = await inspectRouterContainer(
            nodeSettings.namespace
        );
        if (containerStatus === undefined) {
            console.warn(
                `router container for namespace ${nodeSettings.namespace} not found. Skipping OSPF telemetry`
            );
            return;
        }

        const { areaRouterMap, otherASBRs } = await GetRouterOSPFState(
            containerStatus.Id
        );
        const telemetryAreaRouters = Object.fromEntries(
            Array.from(areaRouterMap.entries()).map(([areaId, routers]) => {
                const telemetryRouters = routers.map((r) =>
                    routerInfoToNodeRouterInfo(r)
                );
                return [areaId, telemetryRouters];
            })
        );
        await this.client.sendRouterTelemetry(
            telemetryAreaRouters,
            otherASBRs.map((r) => routerInfoToNodeRouterInfo(r))
        );
    }

    async doSyncOnce() {
        const nodeSettings = this.store.getNodeSettings();
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
        await this.doSyncPeers(nodeSettings, remotePeers);
        await this.doSyncBird(nodeSettings, remoteConfig, remotePeers);

        // collect telemetry
        await this.collectTelemetry(nodeSettings, remotePeers);

        logger.info("Sync completed.");
    }
}
