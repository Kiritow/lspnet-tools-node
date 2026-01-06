import z from "zod";
import { BaseSQLite } from "./base-sqlite";
import getOrCreateLogger from "./base-log";

const _nodeSettingsSchema = z.object({
    namespace: z.string(),
    ethName: z.string(),
    privateKey: z.string(),
    nodeId: z.coerce.number(),
    domainPrefix: z.string(),
});
export type NodeSettings = z.infer<typeof _nodeSettingsSchema>;

const _localUnderlayStateSchema = z.union([
    z.object({
        unit_name: z.string(),
        mode: z.literal("client"),
        listen_port: z.number(),
        server_ip: z.string(),
        server_port: z.number(),
        username: z.string().optional(),
        password: z.string().optional(),
    }),
    z.object({
        unit_name: z.string(),
        mode: z.literal("server"),
        listen_port: z.number(),
        username: z.string().optional(),
        password: z.string().optional(),
    }),
]);

export type LocalUnderlayState = z.infer<typeof _localUnderlayStateSchema>;

export class ConfigStore extends BaseSQLite {
    constructor(filename: string, disableLogger?: boolean) {
        if (disableLogger) {
            super(filename);
            return;
        }

        const logger = getOrCreateLogger("db", {
            level: "debug",
        });
        super(filename, logger);
    }

    async init() {
        await this.run(
            "create table if not exists nodeconfig (key, value, unique (key))"
        );
        await this.run(
            "create table if not exists simplekv (key, value, expires, unique (key))"
        );
        await this.run(
            "create table if not exists wgkey (private, public, unique (public))"
        );
    }

    async getNodeSettings() {
        const results = await this.query("select key, value from nodeconfig");
        if (results.length < 1) {
            return undefined;
        }
        const kvs = z
            .object({ key: z.string(), value: z.unknown() })
            .array()
            .parse(results);
        return _nodeSettingsSchema.parse(
            Object.fromEntries(kvs.map((kv) => [kv.key, kv.value]))
        );
    }

    async getPartialNodeSettings() {
        const results = await this.query("select key, value from nodeconfig");
        if (results.length < 1) {
            return undefined;
        }
        const kvs = z
            .object({ key: z.string(), value: z.unknown() })
            .array()
            .parse(results);
        return _nodeSettingsSchema
            .partial()
            .parse(Object.fromEntries(kvs.map((kv) => [kv.key, kv.value])));
    }

    async setNodeSettings(updates: Partial<NodeSettings>) {
        const kvs = Object.entries(updates)
            .map(([key, value]) => ({
                key,
                value,
            }))
            .filter((kv) => kv.value !== undefined);
        for (const kv of kvs) {
            await this.upsert("nodeconfig", { key: kv.key, value: kv.value }, [
                "value",
            ]);
        }
    }

    async createWireGuardKey(privateKey: string, publicKey: string) {
        return await this.insert("wgkey", {
            private: privateKey,
            public: publicKey,
        });
    }

    async getAllWireGuardKeys() {
        const results = await this.query("select * from wgkey");
        return z
            .object({ private: z.string(), public: z.string() })
            .array()
            .parse(results);
    }

    // Custom simple KV store with optional TTL
    private async _getKey(key: string) {
        const results = await this.query(
            "select value, expires from simplekv where key=?",
            [key]
        );
        if (results.length < 1) {
            return undefined;
        }

        const { value, expires } = z
            .object({ value: z.unknown(), expires: z.number() })
            .parse(results[0]);
        if (expires > Math.floor(Date.now() / 1000)) {
            await this.run("delete from simplekv where key=?", [key]);
            return undefined;
        }

        return value;
    }

    private async _setKey(key: string, value: unknown, ttlSeconds?: number) {
        const useTTL =
            ttlSeconds !== undefined
                ? Math.floor((Date.now() + ttlSeconds * 1000) / 1000)
                : null;
        await this.upsert("simplekv", { key, value, expires: useTTL }, [
            "value",
            "expires",
        ]);
    }

    private async _deleteKey(key: string) {
        await this.run("delete from simplekv where key=?", [key]);
    }

    async getLocalUnderlayState(ifname: string) {
        const v = await this._getKey(`underlay-worker-${ifname}`);
        if (v === undefined) {
            return undefined;
        }

        return _localUnderlayStateSchema.parse(JSON.parse(z.string().parse(v)));
    }

    async deleteLocalUnderlayState(ifname: string) {
        await this._deleteKey(`underlay-worker-${ifname}`);
    }

    async setLocalUnderlayState(ifname: string, state: LocalUnderlayState) {
        await this._setKey(`underlay-worker-${ifname}`, JSON.stringify(state));
    }
}
