import crypto from "node:crypto";
import fs from "node:fs/promises";
import assert from "node:assert";
import z from "zod";

import { logger } from "./common";
import { nsWrap, resolveEndpoint, sudoCall, sudoCallOutput } from "./utils";
import { GetAllAddressFromVethLinkCIDR } from "./shared-utils";
import { AddressV4Info, parseIPAddr } from "./ip-addr";

export async function CreateWireGuardDevice(
    namespace: string,
    name: string,
    address: string,
    mtu: number
) {
    logger.info(`Creating WireGuard device ${name} in namespace ${namespace}`);
    await sudoCall(["ip", "link", "add", name, "type", "wireguard"]);
    if (namespace !== "") {
        await sudoCall(["ip", "link", "set", name, "netns", namespace]);
    }

    await sudoCall(
        nsWrap(namespace, ["ip", "addr", "add", address, "dev", name])
    );
    await sudoCall(
        nsWrap(namespace, ["ip", "link", "set", "dev", name, "mtu", `${mtu}`])
    );
}

export async function AssignWireGuardDevice(
    namespace: string,
    name: string,
    options: {
        private: string;
        listenPort?: number;
        peerPublic?: string;
        endpoint?: string;
        keepalive?: number;
        allowedIPs?: string;
    }
) {
    const tempFilename = `/tmp/${crypto.randomUUID()}.conf`;
    await fs.writeFile(tempFilename, options.private);

    try {
        const args = ["private-key", tempFilename];
        if (options.listenPort) {
            args.push("listen-port", `${options.listenPort}`);
        }
        if (options.peerPublic) {
            args.push("peer", options.peerPublic);
            if (options.endpoint) {
                const resolvedEndpoint = await resolveEndpoint(
                    options.endpoint
                );
                if (resolvedEndpoint.v6) {
                    args.push(
                        "endpoint",
                        `[${resolvedEndpoint.host}]:${resolvedEndpoint.port}`
                    );
                } else {
                    args.push(
                        "endpoint",
                        `${resolvedEndpoint.host}:${resolvedEndpoint.port}`
                    );
                }
            }
            if (options.keepalive) {
                args.push("persistent-keepalive", `${options.keepalive}`);
            }
            if (options.allowedIPs) {
                args.push("allowed-ips", options.allowedIPs);
            }
        }

        await sudoCall(nsWrap(namespace, ["wg", "set", name].concat(args)));
    } finally {
        fs.unlink(tempFilename).catch((err) => {
            console.error(err);
            logger.error(
                `Failed to delete temporary file ${tempFilename}: ${err}`
            );
        });
    }
}

export async function UpWireGuardDevice(namespace: string, name: string) {
    await sudoCall(nsWrap(namespace, ["ip", "link", "set", name, "up"]));
}

export async function CreateVethDevice(
    namespace: string,
    name: string,
    vethNetwork: string
) {
    const hostName = `${name}0`;
    const peerName = `${name}1`;

    await sudoCall([
        "ip",
        "link",
        "add",
        hostName,
        "type",
        "veth",
        "peer",
        peerName,
    ]);
    await sudoCall(["ip", "link", "set", peerName, "netns", namespace]);

    const [vethAddress, vethPeerAddress] =
        GetAllAddressFromVethLinkCIDR(vethNetwork);
    await sudoCall(["ip", "addr", "add", vethAddress, "dev", hostName]);
    await sudoCall([
        "ip",
        "-n",
        namespace,
        "addr",
        "add",
        vethPeerAddress,
        "dev",
        peerName,
    ]);

    await sudoCall(["ip", "link", "set", hostName, "up"]);
    await sudoCall(["ip", "-n", namespace, "link", "set", peerName, "up"]);
}

export async function CreateDummyDevice(
    name: string,
    address: string,
    mtu: number
) {
    await sudoCall(["ip", "link", "add", name, "type", "dummy"]);
    await sudoCall(["ip", "addr", "add", "dev", name, address]);
    await sudoCall(["ip", "link", "set", name, "mtu", `${mtu}`]);
    await sudoCall(["ip", "link", "set", name, "up"]);
}

export async function CreateGREDevice(
    name: string,
    params: {
        address: string;
        mtu: number;
        localIP: string;
        remoteIP: string;
        ttl?: number;
        key?: number;
        checksum?: boolean;
        seqnum?: boolean;
    }
) {
    const callArgs = [
        "ip",
        "link",
        "add",
        name,
        "type",
        "gre",
        "local",
        params.localIP,
        "remote",
        params.remoteIP,
    ];
    if (params.ttl !== undefined) {
        callArgs.push("ttl", `${params.ttl}`);
    }
    if (params.key !== undefined) {
        callArgs.push("key", `${params.key}`);
    }
    if (params.checksum) {
        callArgs.push("csum");
    }
    if (params.seqnum) {
        callArgs.push("seq");
    }

    await sudoCall(callArgs);
    await sudoCall(["ip", "addr", "add", "dev", name, params.address]);
    await sudoCall(["ip", "link", "set", "dev", name, "mtu", `${params.mtu}`]);
    await sudoCall(["ip", "link", "set", "dev", name, "up"]);
}

export async function GetAllLinks(namespace: string) {
    const rawResult = await sudoCallOutput(
        nsWrap(namespace, ["ip", "-j", "link"])
    );
    let jResult: unknown;
    try {
        jResult = JSON.parse(rawResult);
    } catch (err) {
        console.error(err);
        logger.error("GetAllLinks: get json failed, retry in 3000ms...");
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const rawResult2 = await sudoCallOutput(
            nsWrap(namespace, ["ip", "-j", "link"])
        );
        jResult = JSON.parse(rawResult2);
    }

    return z
        .object({
            ifindex: z.number(),
            ifname: z.string(),
            flags: z.array(z.string()),
            mtu: z.number(),
            operstate: z.string(),
            link_type: z.string(),
        })
        .array()
        .parse(jResult);
}

export async function tryDestroyDevice(namespace: string, name: string) {
    const links = await GetAllLinks(namespace);
    if (links.find((link) => link.ifname === name) !== undefined) {
        await sudoCall(nsWrap(namespace, ["ip", "link", "del", name]));
    }
}

export interface WireGuardState {
    private: string;
    public: string;
    listen: number;
    fwmark: number;
    peers: Record<
        string,
        {
            preshared?: string;
            allowedIPs: string;
            handshake: number;
            rx: number;
            tx: number;
            endpoint?: string;
            keepalive?: number;
        }
    >;
}

export async function DumpAllWireGuardState(namespace: string) {
    const output = await sudoCallOutput(
        nsWrap(namespace, ["wg", "show", "all", "dump"])
    );

    const states: Map<string, WireGuardState> = new Map();
    for (const line of output.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        const parts = line.split("\t");
        if (states.get(parts[0]) === undefined) {
            // new interface
            states.set(parts[0], {
                private: parts[1],
                public: parts[2],
                listen: parseInt(parts[3], 10),
                fwmark: parts[4] === "off" ? 0 : parseInt(parts[4], 10),
                peers: {},
            });
        } else {
            // peers
            const state = states.get(parts[0]);
            assert(state !== undefined, "State should not be undefined");
            state.peers[parts[1]] = {
                preshared: parts[2] === "(none)" ? undefined : parts[2],
                endpoint: parts[3] === "(none)" ? undefined : parts[3],
                allowedIPs: parts[4],
                handshake: parseInt(parts[5], 10),
                rx: parseInt(parts[6], 10),
                tx: parseInt(parts[7], 10),
                keepalive:
                    parts[8] === "off" ? undefined : parseInt(parts[8], 10),
            };
        }
    }

    return states;
}

export async function DumpWireGuardState(
    namespace: string,
    name: string
): Promise<WireGuardState> {
    const output = await sudoCallOutput(
        nsWrap(namespace, ["wg", "show", name, "dump"])
    );

    let state: WireGuardState | undefined = undefined;

    for (const line of output.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        const parts = line.split("\t");
        if (parts.length === 4) {
            // new interface
            state = {
                private: parts[0],
                public: parts[1],
                listen: parseInt(parts[2], 10),
                fwmark: parts[3] === "off" ? 0 : parseInt(parts[3], 10),
                peers: {},
            };
        } else {
            // peers
            assert(state !== undefined, "State should not be undefined");
            state.peers[parts[0]] = {
                preshared: parts[1] === "(none)" ? undefined : parts[1],
                endpoint: parts[2] === "(none)" ? undefined : parts[2],
                allowedIPs: parts[3],
                handshake: parseInt(parts[4], 10),
                rx: parseInt(parts[5], 10),
                tx: parseInt(parts[6], 10),
                keepalive:
                    parts[7] === "off" ? undefined : parseInt(parts[7], 10),
            };
        }
    }

    if (state === undefined) {
        throw new Error(`Could not find wireguard device ${name}`);
    }
    return state;
}

const _ipAddrSchema = z.object({
    ifindex: z.number(),
    ifname: z.string(),
    flags: z.array(z.string()),
    mtu: z.number(),
    operstate: z.string(),
    addr_info: z
        .object({
            family: z.string(),
            local: z.string(),
            prefixlen: z.number(),
            scope: z.string(),
            label: z.string().optional(),
            valid_life_time: z.union([z.string(), z.number()]).optional(),
            preferred_life_time: z.union([z.string(), z.number()]).optional(),
        })
        .array(),
});
type _ipAddrSchema = z.infer<typeof _ipAddrSchema>;

export interface InterfaceState {
    name: string;
    mtu: number;
    addrInfo4: AddressV4Info | undefined;

    raw: _ipAddrSchema;
}

function convertInterfaceState(s: _ipAddrSchema): InterfaceState {
    let addrInfo4: AddressV4Info | undefined = undefined;
    for (const addr of s.addr_info) {
        if (addr.family === "inet") {
            addrInfo4 = parseIPAddr(`${addr.local}/${addr.prefixlen}`);
            break;
        }
    }

    return {
        name: s.ifname,
        mtu: s.mtu,
        addrInfo4,

        raw: s,
    };
}

export async function GetAllInterfaceStates(namespace: string | undefined) {
    const rawResult = await sudoCallOutput(
        nsWrap(namespace, ["ip", "-j", "addr", "show"])
    );
    let jResult: unknown;
    try {
        jResult = JSON.parse(rawResult);
    } catch (err) {
        console.error(err);
        logger.error(
            "GetAllInterfaceStates: get json failed, retry in 3000ms..."
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const rawResult2 = await sudoCallOutput(
            nsWrap(namespace, ["ip", "-j", "addr", "show"])
        );
        jResult = JSON.parse(rawResult2);
    }

    return _ipAddrSchema
        .array()
        .parse(jResult)
        .map((s) => convertInterfaceState(s));
}

export async function GetInterfaceState(namespace: string, name: string) {
    const rawResult = await sudoCallOutput(
        nsWrap(namespace, ["ip", "-j", "addr", "show", name])
    );
    let jResult: unknown;
    try {
        jResult = JSON.parse(rawResult);
    } catch (err) {
        console.error(err);
        logger.error(
            `GetInterfaceState: get json for interface ${name} failed, retry in 3000ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const rawResult2 = await sudoCallOutput(
            nsWrap(namespace, ["ip", "-j", "addr", "show", name])
        );
        jResult = JSON.parse(rawResult2);
    }

    const result = _ipAddrSchema.array().parse(jResult);
    if (result.length === 0) {
        throw new Error(`Interface ${name} not found`);
    }

    return convertInterfaceState(result[0]);
}
