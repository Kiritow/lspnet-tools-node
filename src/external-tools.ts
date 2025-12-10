import path from "node:path";
import { sudoCall } from "./utils";

// gost v3
export async function StartGostTLSRelayClient(
    unitName: string,
    installDir: string,
    options: {
        listenPort: number;
        dstHost: string;
        dstPort: number;
        udpTTL: number;
    }
) {
    const binPath = path.join(installDir, "bin", "gost");
    await sudoCall([
        "systemd-run",
        "--unit",
        unitName,
        "--collect",
        "--property",
        "Restart=always",
        "--property",
        "RestartSec=5s",
        binPath,
        `-L=udp://:${options.listenPort}?keepAlive=true&ttl=${options.udpTTL}`,
        `-F=relay+tls://${options.dstHost}:${options.dstPort}`,
    ]);
}

export async function StartGostTLSRelayServer(
    unitName: string,
    installDir: string,
    options: {
        listenPort: number;
        targetPort: number;
    }
) {
    const binPath = path.join(installDir, "bin", "gost");
    await sudoCall([
        "systemd-run",
        "--unit",
        unitName,
        "--collect",
        "--property",
        "Restart=always",
        "--property",
        "RestartSec=5s",
        binPath,
        `-L=relay+tls://:${options.listenPort}/127.0.0.1:${options.targetPort}`,
    ]);
}
