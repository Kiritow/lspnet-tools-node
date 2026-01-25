import { logger } from "./common";
import {
    sudoWrap,
    sudoCall,
    sudoCallOutput,
    simpleCall,
    nsWrap,
} from "./utils";

export async function tryCreateIptablesChain(
    tableName: string,
    chainName: string
) {
    const { code, stderr } = await simpleCall(
        sudoWrap(["iptables", "-t", tableName, "-N", chainName])
    );
    if (code !== 0) {
        if (stderr.includes("iptables: Chain already exists.")) {
            logger.info(
                `iptables chain ${chainName} exists in ${tableName} table, skip creation.`
            );
            return;
        }
        throw new Error(
            `Failed to create iptables chain ${chainName} in ${tableName} table: ${stderr}`
        );
    }
}

export async function tryCheckIptablesRule(
    tableName: string,
    chainName: string,
    ruleArgs: string[]
) {
    const { code, stderr } = await simpleCall(
        sudoWrap(["iptables", "-t", tableName, "-C", chainName, ...ruleArgs])
    );
    if (code !== 0) {
        if (
            stderr.includes(
                "iptables: Bad rule (does a matching rule exist in that chain?)"
            ) ||
            stderr.includes("iptables: No chain/target/match by that name")
        ) {
            return false;
        }

        throw new Error(`Failed to check iptables rule: ${stderr}`);
    }

    return true;
}

export async function tryAppendIptablesRule(
    tableName: string,
    chainName: string,
    ruleArgs: string[]
) {
    if (!(await tryCheckIptablesRule(tableName, chainName, ruleArgs))) {
        logger.info(
            `iptables rule not exist, adding: iptables -t ${tableName} -A ${chainName} ${ruleArgs.join(" ")}`
        );
        await sudoCall([
            "iptables",
            "-t",
            tableName,
            "-A",
            chainName,
            ...ruleArgs,
        ]);
    }
}

export async function tryInsertIptablesRule(
    tableName: string,
    chainName: string,
    ruleArgs: string[]
) {
    if (!(await tryCheckIptablesRule(tableName, chainName, ruleArgs))) {
        logger.info(
            `iptables rule not exist, inserting: iptables -t ${tableName} -I ${chainName} ${ruleArgs.join(" ")}`
        );
        await sudoCall([
            "iptables",
            "-t",
            tableName,
            "-I",
            chainName,
            ...ruleArgs,
        ]);
    }
}

export async function tryDeleteIptablesRule(
    tableName: string,
    chainName: string,
    ruleArgs: string[]
) {
    if (await tryCheckIptablesRule(tableName, chainName, ruleArgs)) {
        logger.info(
            `iptables rule exist, deleting: iptables -t ${tableName} -D ${chainName} ${ruleArgs.join(" ")}`
        );
        await sudoCall([
            "iptables",
            "-t",
            tableName,
            "-D",
            chainName,
            ...ruleArgs,
        ]);
    }
}

export async function tryFlushIptables(tableName: string, chainName: string) {
    try {
        await sudoCall(["iptables", "-t", tableName, "-F", chainName]);
    } catch (e) {
        console.log(e);
        logger.warn(`flush iptables ${tableName} ${chainName} failed: ${e}`);
    }
}

export async function EnsureIPTables(namespace: string) {
    await tryCreateIptablesChain("nat", `${namespace}-POSTROUTING`);
    await tryInsertIptablesRule("nat", "POSTROUTING", [
        "-j",
        `${namespace}-POSTROUTING`,
    ]);

    await tryCreateIptablesChain("nat", `${namespace}-PREROUTING`);
    await tryInsertIptablesRule("nat", "PREROUTING", [
        "-j",
        `${namespace}-PREROUTING`,
    ]);

    await tryCreateIptablesChain("raw", `${namespace}-PREROUTING`);
    await tryInsertIptablesRule("raw", "PREROUTING", [
        "-j",
        `${namespace}-PREROUTING`,
    ]);

    await tryCreateIptablesChain("mangle", `${namespace}-OUTPUT`);
    await tryInsertIptablesRule("mangle", "OUTPUT", [
        "-j",
        `${namespace}-OUTPUT`,
    ]);

    await tryCreateIptablesChain("mangle", `${namespace}-POSTROUTING`);
    await tryInsertIptablesRule("mangle", "POSTROUTING", [
        "-j",
        `${namespace}-POSTROUTING`,
    ]);

    await tryCreateIptablesChain("filter", `${namespace}-FORWARD`);
    await tryInsertIptablesRule("filter", "FORWARD", [
        "-j",
        `${namespace}-FORWARD`,
    ]);

    await tryCreateIptablesChain("filter", `${namespace}-INPUT`);
    await tryInsertIptablesRule("filter", "INPUT", [
        "-j",
        `${namespace}-INPUT`,
    ]);
}

export async function ClearIPTables(namespace: string) {
    await tryFlushIptables("nat", `${namespace}-POSTROUTING`);
    await tryFlushIptables("nat", `${namespace}-PREROUTING`);
    await tryFlushIptables("raw", `${namespace}-PREROUTING`);
    await tryFlushIptables("mangle", `${namespace}-OUTPUT`);
    await tryFlushIptables("mangle", `${namespace}-POSTROUTING`);
    await tryFlushIptables("filter", `${namespace}-FORWARD`);
    await tryFlushIptables("filter", `${namespace}-INPUT`);

    // in namespace
    try {
        await sudoCall(nsWrap(namespace, ["iptables", "-F", "FORWARD"]));
    } catch (e) {
        console.log(e);
        logger.warn(
            `flush iptables FORWARD chain in namespace ${namespace} failed: ${e}`
        );
    }
}

// <table, rules[]>
export async function GetAllIPTablesRules() {
    const output = await sudoCallOutput(["iptables-save"]);

    let currentTableName = "";
    const tableRules: Map<string, string[]> = new Map();

    for (const line of output.split("\n")) {
        if (
            line.trim() === "" ||
            line.startsWith("#") ||
            line.startsWith("COMMIT")
        )
            continue;

        if (line.startsWith("*")) {
            currentTableName = line.slice(1);
            tableRules.set(currentTableName, []);
            continue;
        }

        if (line.startsWith(":")) {
            // chain, TODO: Handle chain definitions if needed
            continue;
        }

        if (line.startsWith("-A")) {
            // rule
            tableRules.get(currentTableName)!.push(line);
            continue;
        }

        console.warn(`Unknown iptables-save output: ${line}`);
    }

    return tableRules;
}
