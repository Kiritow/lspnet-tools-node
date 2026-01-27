import assert from "node:assert";
import dnsPromise from "node:dns/promises";
import { spawn } from "node:child_process";
import z from "zod";
import { logger } from "./common";

export function sudoWrap(args: string[]) {
    if (process.geteuid!() != 0) {
        logger.debug(`sudo: ${args.join(" ")}`);
        return ["sudo", ...args];
    }

    return args;
}

export function nsWrap(namespace: string | undefined, args: string[]) {
    if (namespace !== undefined && namespace !== "") {
        return ["ip", "netns", "exec", namespace].concat(args);
    }

    return args;
}

export async function sudoCall(args: string[]) {
    const useArgs = sudoWrap(args);
    return await checkedCall(useArgs);
}

export async function sudoCallOutput(args: string[]) {
    const useArgs = sudoWrap(args);
    return await checkedCallOutput(useArgs);
}

export async function checkedCall(args: string[]) {
    const { code, stdout, stderr } = await simpleCall(args);
    if (stdout.length > 0) {
        console.log(stdout);
    }
    if (stderr.length > 0) {
        console.error(stderr);
    }
    if (code !== 0) {
        throw new Error(
            `checkedCall: child process exited with code: ${code}, stderr: ${stderr}. Command: ${args.join(
                " "
            )}`
        );
    }
}

export async function checkedCallOutput(args: string[]) {
    const { code, stdout, stderr } = await simpleCall(args);
    if (stderr.length > 0) {
        console.error(stderr);
    }
    if (code !== 0) {
        throw new Error(
            `checkedCall: child process exited with code: ${code}, stderr: ${stderr}. Command: ${args.join(
                " "
            )}`
        );
    }

    return stdout;
}

export async function simpleCall(args: string[], writeInput?: Buffer) {
    return new Promise<{
        code: number;
        stdout: string;
        stderr: string;
        signal?: string;
    }>((resolve, reject) => {
        const child = spawn(args[0], args.slice(1));
        if (writeInput !== undefined) {
            child.stdin.write(writeInput);
            child.stdin.end();
        }

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            if (typeof chunk === "string") {
                stdout += chunk;
            } else if (chunk instanceof Buffer) {
                stdout += chunk.toString();
            } else {
                stdout += `${chunk}`;
            }
        });
        child.stderr.on("data", (chunk) => {
            if (typeof chunk === "string") {
                stderr += chunk;
            } else if (chunk instanceof Buffer) {
                stderr += chunk.toString();
            } else {
                stderr += `${chunk}`;
            }
        });
        child.on("exit", (code, signal) => {
            if (code !== null) {
                return resolve({ code, stdout, stderr });
            }

            assert(
                signal !== null,
                "signal should not be null (either code or signal is null)"
            );

            return resolve({
                code: -1,
                stdout,
                stderr,
                signal,
            });
        });
    });
}

export async function resolveEndpoint(endpoint: string) {
    if (endpoint.startsWith("[")) {
        // IPv6 literal address
        const host = endpoint.split("]")[0].substring(1);
        const port = endpoint.split("]")[1].substring(1);
        return { host, port: parseInt(port, 10), v6: true };
    }

    const parts = endpoint.split(":");
    assert(parts.length === 2, `Invalid endpoint format: ${endpoint}`);
    const endpointHost = parts[0];
    const port = parseInt(parts[1], 10);

    const result = await dnsPromise.lookup(endpointHost, 4);
    if (result.address !== endpointHost) {
        logger.info(`endpoint ${endpointHost} resolved to ${result.address}`);
    }

    return { host: result.address, port, v6: false };
}

export async function getAllLoadedSystemdServices() {
    const output = await sudoCallOutput([
        "systemctl",
        "show",
        "*",
        "--state=loaded",
        "--property=Id",
        "--value",
    ]);
    return new Set(output.split("\n").filter((line) => line.trim() !== ""));
}

export async function StopSystemdServiceBestEffort(unitName: string) {
    if (!unitName.endsWith(".service")) {
        logger.warn(`unit name ${unitName} does not end with .service`);
    }

    const allUnits = await getAllLoadedSystemdServices();
    if (!allUnits.has(unitName)) return;

    logger.info(`Stopping systemd service ${unitName}`);
    try {
        await sudoCallOutput(["systemctl", "stop", unitName]);
    } catch (e) {
        console.error(e);
        logger.warn(`failed to stop systemd service ${unitName}: ${e}`);
    }
}

export function formatTempDirPath(namespace: string) {
    return `/tmp/networktools-${namespace}`;
}

export function formatUnitname(namespace: string, type: string) {
    return `networktools-${namespace}-${type}-${crypto.randomUUID()}`;
}

export function withDefaultNumber(n: number | undefined, def: number) {
    if (n === undefined || Number.isNaN(n) || !Number.isFinite(n) || n === 0) {
        return def;
    }

    return n;
}

class _ZeroableString {
    constructor(public value: string | undefined) {}

    or(defaultValue: string | _ZeroableString): _ZeroableString {
        if (this.value !== undefined && this.value !== "") {
            return this;
        }

        if (defaultValue instanceof _ZeroableString) {
            return defaultValue;
        }

        return new _ZeroableString(defaultValue);
    }
}

export function ZeroableString(value: string | undefined) {
    return new _ZeroableString(value);
}

export async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readableZodError<T>(err: z.ZodError<T>): string {
    return err.issues
        .map((e) => {
            const readablePath = e.path
                .map((p) => {
                    if (typeof p === "number") {
                        return `[${p}]`;
                    }
                    if (typeof p === "string") {
                        return `.${p}`;
                    }
                    // symbol
                    return `.${String(p)}`;
                })
                .join("")
                .substring(1);
            return `${readablePath}: ${e.message}`;
        })
        .join("; ");
}
