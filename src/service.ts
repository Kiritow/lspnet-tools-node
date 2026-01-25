import assert from "node:assert";
import { ControlAgent } from "@/controller";
import { NodeManagerClient } from "@/nodemanager-client";
import { getOrInitNodeInteractive } from "@/cli-api";
import { EnsureNetNs } from "./ensures";
import { DumpAllWireGuardState, tryDestroyDevice } from "./device";
import { ClearIPTables } from "./iptables";
import { shutdownRouterContainer } from "./podman";
import { NodeSettings } from "./config-store";
import { sleep } from "./utils";

async function cleanUpEverything(nodeSettings: NodeSettings) {
    console.log(`Cleaning up all configurations...`);
    await EnsureNetNs(nodeSettings.namespace);
    // stop all wireguard devices
    const interfaces = await DumpAllWireGuardState(nodeSettings.namespace);
    for (const [ifname] of interfaces) {
        console.log(` - Removing WireGuard interface ${ifname}`);
        await tryDestroyDevice(nodeSettings.namespace, ifname);
    }

    console.log(`Stopping veth pairs...`);
    await tryDestroyDevice("", `${nodeSettings.namespace}-veth0`);

    console.log(`Cleaning up iptables...`);
    await ClearIPTables(nodeSettings.namespace);

    console.log(`Stopping containers...`);
    await shutdownRouterContainer(nodeSettings.namespace, true);

    console.log(`Cleanup completed.`);
}

export async function ServiceMain(databasePath: string) {
    const { store } = await getOrInitNodeInteractive(databasePath);
    const nodeSettings = store.getNodeSettings();
    assert(nodeSettings !== undefined, "Node settings are not configured");
    await cleanUpEverything(nodeSettings);
    await sleep(1000);

    console.log(`Starting main service loop...`);
    for (;;) {
        try {
            const nodeClient = new NodeManagerClient(nodeSettings);
            const agent = new ControlAgent(store, nodeClient);
            await agent.doSyncOnce();
        } catch (err) {
            console.error(err);
        }

        await sleep(60000);
    }
}
