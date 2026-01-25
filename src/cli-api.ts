import assert from "node:assert";
import fs from "node:fs";
import { input } from "@inquirer/prompts";
import { ConfigStore } from "./config-store";
import { CreateNewNodePrivateKey } from "./pki";
import { JoinCluster } from "./nodemanager-client";

export async function getOrInitNodeInteractive(databasePath: string) {
    let store: ConfigStore;
    if (fs.statSync(databasePath, { throwIfNoEntry: false }) !== undefined) {
        store = new ConfigStore(databasePath, true);
        await store.init();
    } else {
        store = new ConfigStore(databasePath, true);
        await store.init();

        const privateKeyPEM = CreateNewNodePrivateKey();
        await store.setNodeSettings({
            privateKey: privateKeyPEM,
        });
        console.log(`Private key generated for node.`);
        const ethIfName = await input({
            message: "Enter Ethernet interface name:",
        });
        assert(ethIfName.length > 0, "Interface name cannot be empty");
        await store.setNodeSettings({
            ethName: ethIfName,
        });
        const namespace = await input({
            message: "Enter namespace for the node:",
        });
        assert(namespace.length > 0, "Namespace cannot be empty");
        await store.setNodeSettings({
            namespace: namespace,
        });
        console.log(`Node initialized and saved to ${databasePath}`);
    }

    const nodeSettings = await store.getPartialNodeSettings();
    let privateKeyPEM = nodeSettings?.privateKey;
    if (privateKeyPEM === undefined || privateKeyPEM.length < 1) {
        privateKeyPEM = CreateNewNodePrivateKey();
        await store.setNodeSettings({
            privateKey: privateKeyPEM,
        });
        console.log(`Private key generated for node.`);
    }
    if (
        nodeSettings?.ethName === undefined ||
        nodeSettings.ethName.length < 1
    ) {
        const ethIfName = await input({
            message: "Enter Ethernet interface name:",
        });
        assert(ethIfName.length > 0, "Interface name cannot be empty");
        await store.setNodeSettings({
            ethName: ethIfName,
        });
    }
    if (
        nodeSettings?.namespace === undefined ||
        nodeSettings.namespace.length < 1
    ) {
        const namespace = await input({
            message: "Enter namespace for the node:",
        });
        assert(namespace.length > 0, "Namespace cannot be empty");
        await store.setNodeSettings({
            namespace: namespace,
        });
    }

    if (
        nodeSettings?.domainPrefix === undefined ||
        nodeSettings.domainPrefix.length < 1
    ) {
        const domainPrefix = await input({
            message:
                "Enter controller domain prefix (e.g., https://example.com):",
        });
        assert(domainPrefix.length > 0, "Domain prefix cannot be empty");
        const token = await input({
            message: `Enter join-cluster token for ${domainPrefix}:`,
        });
        const nodeId = await JoinCluster(privateKeyPEM, domainPrefix, token);
        await store.setNodeSettings({
            nodeId,
            domainPrefix,
        });
        console.log(`Joined cluster and obtained node ID ${nodeId}.`);
    } else {
        assert(
            nodeSettings?.nodeId !== undefined,
            "nodeId should be defined after a join-cluster operation"
        );
    }

    return { store, nodeSettings };
}
