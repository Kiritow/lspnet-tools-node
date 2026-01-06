import { ChildProcess, spawn } from "node:child_process";
import assert from "node:assert";
import { nsWrap } from "./utils";
import { GetInterfaceState } from "./device";
import { GetAllAddressFromLinkNetworkCIDR } from "./shared-utils";

export class PingRunner {
    private child: ChildProcess | undefined;
    public latest: { t: Date; ping: number } | undefined;

    constructor(
        private namespace: string,
        private targetIP: string,
        private callback?: (t: Date, ping: number) => void,
        private intervalSeconds?: number, // default to 1 second
        private directLink?: boolean // default to false
    ) {
        this.child = undefined;
    }

    onReceivePing(output: string) {
        // Output example: [1746953216.707353] 64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.014 ms
        // Error example: [1746953304.568747] From 192.168.48.5 icmp_seq=1 Destination Host Unreachable

        // if (!output.startsWith("[")) return;

        // This is a timestamp
        const match = output.match(/^\[(\d+(\.\d+)?)\]/);
        if (match === null) return;
        const t = new Date(parseFloat(match[1]) * 1000);

        if (output.includes("ttl=") && output.includes("time=")) {
            const match = output.match(/time=(\d+(\.\d+)?) ms/);
            if (match === null) return;

            const ping = parseFloat(match[1]);
            this.latest = { t, ping };
            this.callback?.(t, ping);
        }
    }

    start() {
        if (this.child !== undefined) {
            throw new Error("Ping is already running");
        }

        const args = (() => {
            if (this.directLink) {
                return nsWrap(this.namespace, [
                    "ping",
                    "-D",
                    "-n",
                    "-i",
                    `${this.intervalSeconds ?? 1}`,
                    "-r",
                    this.targetIP,
                ]);
            }

            return nsWrap(this.namespace, [
                "ping",
                "-D",
                "-n",
                "-i",
                `${this.intervalSeconds ?? 1}`,
                this.targetIP,
            ]);
        })();

        const child = spawn(args[0], args.slice(1));

        let buffer = "";
        child.stdout.on("data", (chunk) => {
            if (typeof chunk === "string") {
                buffer += chunk;
            } else if (chunk instanceof Buffer) {
                buffer += chunk.toString();
            } else {
                buffer += `${chunk}`;
            }

            if (buffer.includes("\n")) {
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    this.onReceivePing(line);
                }
            }
        });

        this.child = child;
    }

    stop() {
        if (this.child === undefined) return;

        if (!this.child.kill()) {
            console.error(`Failed to kill ping process: ${this.child.pid}`);
        }

        this.child = undefined;
    }
}

function TrimmedMean(numbers: number[]) {
    if (numbers.length < 1) return undefined;
    const sorted = [...numbers].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * 0.1);
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
    if (trimmed.length < 1) {
        const sum = sorted.reduce((a, b) => a + b, 0);
        return sum / sorted.length;
    }

    const sum = trimmed.reduce((a, b) => a + b, 0);
    return sum / trimmed.length;
}

export async function CalculateMultiplePings(
    namespace: string,
    ifnames: string[]
) {
    if (ifnames.length === 0) {
        return new Map<string, number | undefined>();
    }

    const runners = await Promise.all(
        ifnames.map(async (ifname) => {
            try {
                const interfaceState = await GetInterfaceState(
                    namespace,
                    ifname
                );
                assert(
                    interfaceState.address !== undefined,
                    `interface ${ifname} has no address`
                );
                const allIPs = GetAllAddressFromLinkNetworkCIDR(
                    interfaceState.address
                );
                const otherEndIP = allIPs.find(
                    (ip) => ip !== interfaceState.address
                );
                assert(
                    otherEndIP !== undefined,
                    `cannot find other end IP for ${ifname}`
                );
                const results: number[] = [];
                const runner = new PingRunner(
                    namespace,
                    otherEndIP,
                    (t, pingMs) => {
                        results.push(pingMs);
                    },
                    1,
                    true
                );
                runner.start();
                return { ifname, runner, results };
            } catch (e) {
                console.error(
                    `failed to start ping for ${ifname}: ${e instanceof Error ? e.message : e}`
                );
                return { ifname, runner: undefined, results: [] };
            }
        })
    );

    await new Promise((resolve) => setTimeout(resolve, 10000));

    for (const info of runners) {
        info.runner?.stop();
    }

    return new Map(
        runners.map((info) => {
            const meanPingMs = TrimmedMean(info.results);
            return [info.ifname, meanPingMs];
        })
    );
}
