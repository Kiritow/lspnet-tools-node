import crypto from "node:crypto";
import axios from "axios";
import z from "zod";
import { NodeSettings } from "./config-store";
import { PrivateKeyWrapper } from "./pki";

export interface NodeRouterInfo {
    router_id: string;
    distance: number;
    vlinks: {
        metric: number;
        router_id: string;
    }[];
    routers: {
        metric: number;
        router_id: string;
    }[];
    stubnets: {
        network: string;
        metric: number;
    }[];
    xnetworks: {
        network: string;
        metric: number;
    }[];
    xrouters: {
        metric: number;
        router_id: string;
    }[];
    externals: {
        network: string;
        metric: number;
        metric_type: number;
        via?: string | null | undefined;
        tag?: string | null | undefined;
    }[];
    nssa_externals: {
        network: string;
        metric: number;
        metric_type: number;
        via?: string | null | undefined;
        tag?: string | null | undefined;
    }[];
}

const _remoteNodeInfoSchema = z.object({
    ip: z.string(),
    external: z.boolean(),
    ddns: z.boolean(),
    exitNode: z.boolean(),
    vethCIDR: z.string().optional(),
    allowedTCPPorts: z.number().array(),
    allowedUDPPorts: z.number().array(),
    dummy: z
        .object({
            name: z.string(),
            addressCIDR: z.string(),
            mtu: z.number(),
        })
        .array()
        .optional(),
    ospf: z
        .object({
            area: z.number(),
            cost: z.number(),
            auth: z.string(),
        })
        .optional(),
});

export type RemoteNodeInfo = z.infer<typeof _remoteNodeInfoSchema>;

const _remotePeerSchema = z.object({
    id: z.number(),
    publicKey: z.string(),
    listenPort: z.number(),
    mtu: z.number(),
    addressCIDR: z.string(),
    peerPublicKey: z.string(),
    keepalive: z.number(),
    endpoint: z.string(),
    extra: z.string(),
});

export type RemotePeerInfoRaw = z.infer<typeof _remotePeerSchema>;

const _remotePeerExtraSchema = z
    .object({
        templateId: z.number(),
        ospf: z.object({
            cost: z.number(),
            ping: z.boolean(),
            offset: z.number(),
            auth: z.string().optional(),
        }),
        endpointMode: z.number(),
        endpointHost: z.string(),
        multilisten: z.number().array(),
        multiport: z.number().array(),
        underlay: z.union([
            z.object({
                provider: z.literal("gost_relay_client"),
                config_gost_relay_client: z.object({
                    listen_port: z.number(),
                    server_addr: z.string(),
                    server_port: z.number(),
                    username: z.string().optional(),
                    password: z.string().optional(),
                }),
            }),
            z.object({
                provider: z.literal("gost_relay_server"),
                config_gost_relay_server: z.object({
                    listen_port: z.number(),
                    username: z.string().optional(),
                    password: z.string().optional(),
                }),
            }),
        ]),
    })
    .partial();

export type RemotePeerExtra = z.infer<typeof _remotePeerExtraSchema>;

export type RemotePeerInfo = Omit<RemotePeerInfoRaw, "extra"> & {
    extra: RemotePeerExtra | undefined;
};

export class NodeManagerClient {
    private nodeSettings: NodeSettings;
    private privateKey: PrivateKeyWrapper;

    constructor(nodeConfig: NodeSettings) {
        this.nodeSettings = nodeConfig;
        this.privateKey = new PrivateKeyWrapper(nodeConfig.privateKey);
    }

    async get(url: string, params?: Record<string, string>): Promise<unknown> {
        const nonce = crypto.randomBytes(8).toString("hex");
        const queryString = new URLSearchParams(params ?? {}).toString();
        const signData = `${url}\n${nonce}\n${queryString}`;
        const signature = this.privateKey
            .sign(Buffer.from(signData))
            .toString("hex");

        const res = await axios.get(
            `${this.nodeSettings.domainPrefix}${url}?${queryString}`,
            {
                headers: {
                    "X-Client-Id": this.privateKey.getKeyHash(),
                    "X-Client-Nonce": nonce,
                    "X-Client-Sign": signature,
                },
            }
        );
        if (res.status !== 200) {
            throw new Error(
                `Failed to get data from ${url}: ${res.status} ${res.statusText}`
            );
        }

        return res.data;
    }

    async post(url: string, data?: Record<string, unknown>): Promise<unknown> {
        const nonce = crypto.randomBytes(8).toString("hex");
        const signData = `${url}\n${nonce}\n${JSON.stringify(data)}`;
        const signature = this.privateKey
            .sign(Buffer.from(signData))
            .toString("hex");

        const res = await axios.post(
            `${this.nodeSettings.domainPrefix}${url}`,
            data,
            {
                headers: {
                    "X-Client-Id": this.privateKey.getKeyHash(),
                    "X-Client-Nonce": nonce,
                    "X-Client-Sign": signature,
                },
            }
        );

        if (res.status !== 200) {
            throw new Error(
                `Failed to post data to ${url}: ${res.status} ${res.statusText}`
            );
        }

        return res.data;
    }

    async getNodeInfo() {
        const res = await this.get("/api/v1/node/info");
        return z
            .object({
                id: z.number(),
                clusterId: z.number(),
                nodeName: z.string(),
                publicSignKey: z.string(),
                publicSignKeyHash: z.string(),
                status: z.number(),
                lastSeen: z.coerce.date(),
            })
            .parse(res);
    }

    async getNodeConfig() {
        const res = await this.get("/api/v1/node/config");
        const rawConfig = z.object({ config: z.string() }).parse(res).config;
        const config = JSON.parse(rawConfig);
        return _remoteNodeInfoSchema.parse(config);
    }

    async getPeers() {
        const res = await this.get("/api/v1/node/peers");
        const { peers } = z
            .object({ peers: _remotePeerSchema.array() })
            .parse(res);
        return peers.map((p) => {
            const { extra, ...rest } = p;
            try {
                const pExtra = _remotePeerExtraSchema.parse(JSON.parse(extra));
                return {
                    ...rest,
                    extra: pExtra,
                };
            } catch (e) {
                return {
                    ...rest,
                    extra: undefined,
                };
            }
        });
    }

    async syncWireGuardKeys(publicKeys: string[]) {
        await this.post("/api/v1/node/sync_wireguard_keys", {
            keys: publicKeys,
        });
    }

    async sendLinkTelemetry(
        links: { id: number; ping: number; rx: number; tx: number }[]
    ) {
        await this.post("/api/v1/node/link_telemetry", {
            links: links,
        });
    }

    async sendRouteTelemetry(
        areaRoutes: Record<string, NodeRouterInfo[]>,
        otherASBRs: NodeRouterInfo[]
    ) {
        await this.post("/api/v1/node/route_telemetry", {
            area_routes: areaRoutes,
            other_asbrs: otherASBRs,
        });
    }
}

export async function JoinCluster(
    privateKeyPEM: string,
    domainPrefix: string,
    token: string,
    nodeName?: string
) {
    const key = new PrivateKeyWrapper(privateKeyPEM);
    let useDomainPrefix = domainPrefix;
    if (
        !useDomainPrefix.startsWith("http://") &&
        !useDomainPrefix.startsWith("https://")
    ) {
        useDomainPrefix = `https://${useDomainPrefix}`;
    }
    if (!useDomainPrefix.startsWith("https")) {
        console.warn("Warning: Joining cluster over non-HTTPS connection");
    }

    const res = await axios.post(
        `${useDomainPrefix}/api/v1/node/join`,
        {
            token,
            name: nodeName ?? crypto.randomUUID(),
            publicSignKey: key.getPublicKeyPEM(),
        },
        {
            validateStatus: () => true, // do not throw on non-200 status
        }
    );
    if (res.status !== 200) {
        throw new Error(
            `Failed to join cluster: ${res.status} ${res.statusText}`
        );
    }

    const { id: nodeId } = z
        .object({
            id: z.number(),
        })
        .parse(res.data);

    return nodeId;
}
