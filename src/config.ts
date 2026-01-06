import assert from "node:assert";

export function GetInstallDir() {
    const installDir = process.env.INSTALL_DIR;
    assert(installDir !== undefined, "INSTALL_DIR is not set");
    return installDir;
}
