import z from "zod";

import {
    formatTempDirPath,
    getAllLoadedSystemdServices,
    sudoCall,
    sudoCallOutput,
} from "./utils";
import { logger } from "./common";

async function podmanListContainers() {
    const result = await sudoCallOutput([
        "podman",
        "ps",
        "-a",
        "--format=json",
    ]);
    return z
        .object({
            Id: z.string(),
            Names: z.string().array(),
        })
        .array()
        .parse(JSON.parse(result));
}

async function inspectContainer(containerIdOrName: string) {
    const result = await sudoCallOutput([
        "podman",
        "container",
        "inspect",
        containerIdOrName,
    ]);
    const parsedResult = z
        .object({
            Id: z.string(),
            State: z.object({
                Status: z.string(),
            }),
            HostConfig: z.object({
                Binds: z.string().array(),
            }),
        })
        .array()
        .parse(JSON.parse(result));

    if (parsedResult.length === 0) {
        return undefined;
    }
    return parsedResult[0];
}

export async function inspectRouterContainer(namespace: string) {
    const containers = await podmanListContainers();
    const container = containers.find((c) =>
        c.Names.includes(`${namespace}-router`)
    );
    if (container === undefined) {
        logger.warn(`Router container ${namespace}-router not found`);
        return undefined;
    }

    return await inspectContainer(container.Id);
}

async function tryStopContainerFromSystemd(unitName: string) {
    const allUnits = await getAllLoadedSystemdServices();
    if (!allUnits.has(unitName)) return;

    logger.info(`Stopping systemd service ${unitName}`);
    try {
        await sudoCallOutput(["systemctl", "stop", unitName]);
    } catch (e) {
        console.error(e);
        logger.warn(
            `failed to stop systemd service ${unitName}: ${e instanceof Error ? e.message : String(e)}`
        );
    }
}

export async function shutdownRouterContainer(
    namespace: string,
    needClearTemp?: boolean // default to false
) {
    const container = await inspectRouterContainer(namespace);
    if (container === undefined) return;

    await tryStopContainerFromSystemd(
        `networktools-${namespace}-router.service`
    );

    logger.info(`Removing container ${container.Id}`);
    await sudoCallOutput(["podman", "rm", "-f", container.Id]);

    if (needClearTemp) {
        const bind = container.HostConfig.Binds.find((p) =>
            p.startsWith(formatTempDirPath(namespace))
        );
        if (bind !== undefined) {
            const tempDirPath = bind.split(":")[0];
            logger.info(`Removing temp dir ${tempDirPath}`);
            await sudoCall(["rm", "-rf", tempDirPath]);
        }
    }
}

export async function startRouterContainerWithSystemd(namespace: string) {
    logger.info(`Creating router container with namespace: ${namespace}`);
    await sudoCall([
        "podman",
        "create",
        "--network",
        `ns:/var/run/netns/${namespace}`,
        "--cap-add",
        "NET_ADMIN",
        "--cap-add",
        "CAP_NET_BIND_SERVICE",
        "--cap-add",
        "NET_RAW",
        "--cap-add",
        "NET_BROADCAST",
        "-v",
        `${formatTempDirPath(namespace)}/router:/data:ro`,
        "--name",
        `${namespace}-router`,
        "bird-router",
    ]);
    const container = await inspectRouterContainer(namespace);
    if (container === undefined) {
        throw new Error(
            `Failed to create router container with namespace: ${namespace}`
        );
    }

    logger.info(
        `Starting router container with namespace: ${namespace} via systemd...`
    );
    await sudoCall([
        "systemd-run",
        "--unit",
        `networktools-${namespace}-router.service`,
        "--collect",
        "--property",
        "KillMode=none",
        "--property",
        "Type=forking",
        "podman",
        "start",
        container.Id,
    ]);
}
