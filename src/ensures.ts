import path from "node:path";
import assert from "node:assert";
import z from "zod";
import { formatTempDirPath, nsWrap, sudoCall, sudoCallOutput } from "./utils";
import {
    inspectRouterContainer,
    shutdownRouterContainer,
    startRouterContainerWithSystemd,
} from "./podman";

export async function EnsureNetNs(namespace: string) {
    const output = await sudoCallOutput(["ip", "-j", "netns", "list"]);
    if (output.trim() !== "") {
        const netnsList = z
            .object({ name: z.string() })
            .array()
            .parse(JSON.parse(output));
        if (netnsList.find((ns) => ns.name === namespace) !== undefined) {
            return;
        }
    }

    await sudoCall(["ip", "netns", "add", namespace]);
}

export async function EnsureIPForward(namespace: string) {
    await sudoCall(["sysctl", "-w", `net.ipv4.ip_forward=1`]);
    await sudoCall(
        nsWrap(namespace, ["sysctl", "-w", `net.ipv4.ip_forward=1`])
    );
}

export async function EnsureTempDir(namespace: string) {
    await sudoCall(["mkdir", "-p", formatTempDirPath(namespace)]);
    await sudoCall([
        "mkdir",
        "-p",
        path.join(formatTempDirPath(namespace), "router"),
    ]);
}

export async function EnsureRouterContainer(namespace: string) {
    const containerStatus = await inspectRouterContainer(namespace);
    if (containerStatus !== undefined) {
        if (containerStatus.State.Status === "running") {
            return containerStatus.Id;
        }

        // container exists but not running, shutdown it first
        await shutdownRouterContainer(namespace, false);
    }

    // start the container
    await startRouterContainerWithSystemd(namespace);
    const containerStatus2 = await inspectRouterContainer(namespace);
    assert(
        containerStatus2 !== undefined,
        `Failed to start router container for namespace ${namespace}`
    );
    return containerStatus2.Id;
}
