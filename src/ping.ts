import { ChildProcess, spawn } from "node:child_process";
import { nsWrap } from "./utils";

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

        this.child.kill();
        this.child = undefined;
    }
}
