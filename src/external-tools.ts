import path from "node:path";
import { isEmptyString, sudoCall } from "./utils";

// userinfo part of gost url, auth is enabled only if both username and password are given.
function formatGostAuth(username?: string, password?: string) {
    if (isEmptyString(username) || isEmptyString(password)) {
        return "";
    }

    return `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
}

// gost v3
export async function StartGostTLSRelayClient(
    unitName: string,
    installDir: string,
    options: {
        listenPort: number;
        dstHost: string;
        dstPort: number;
        udpTTL: number;
        username?: string;
        password?: string;
    }
) {
    const binPath = path.join(installDir, "bin", "gost");
    const auth = formatGostAuth(options.username, options.password);
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
        `-F=relay+tls://${auth}${options.dstHost}:${options.dstPort}`,
    ]);
}

export async function StartGostTLSRelayServer(
    unitName: string,
    installDir: string,
    options: {
        listenPort: number;
        targetPort: number;
        username?: string;
        password?: string;
    }
) {
    const binPath = path.join(installDir, "bin", "gost");
    const auth = formatGostAuth(options.username, options.password);
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
        `-L=relay+tls://${auth}:${options.listenPort}/127.0.0.1:${options.targetPort}`,
    ]);
}
