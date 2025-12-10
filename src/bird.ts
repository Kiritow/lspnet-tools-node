import dayjs from "dayjs";

export interface CommonOSPFConfig {
    area?: number;
    cost?: number;
    auth?: string;
    type?: string;
    // pingcost?: number; // legacy. Now controller will calculate `cost` and merge it with `offset`.
}

export interface BFDConfig {
    intervalMs?: number;
    txMs?: number;
    rxMs?: number;
    idleMs?: number;
    multiplier?: number;
}

function formatLocalNetAndFilter(
    defineName: string,
    direction: "import" | "export",
    cidrs: string[]
) {
    if (cidrs.length < 1) {
        return { defineText: "", filterText: `${direction} all` };
    }

    return {
        defineText: `define ${defineName}=[${cidrs.join(",")}];`,
        filterText: `${direction} filter {
if net !~ ${defineName} then accept;
else reject;
}`,
    };
}

function formatOSPFConfig(
    ospfAreaConfig: Record<string, Record<string, CommonOSPFConfig>>,
    bfdConfig: Record<string, BFDConfig>
) {
    return Object.entries(ospfAreaConfig)
        .map(([areaId, areaConfig]) => {
            const interfacePart = Object.entries(areaConfig).map(
                ([interfaceName, config]) => {
                    const parts = [`interface "${interfaceName}" {`];
                    if (bfdConfig[interfaceName] !== undefined) {
                        parts.push("bfd yes;");
                    }
                    if (config.cost !== undefined) {
                        parts.push(`cost ${config.cost};`);
                    }
                    if (config.type !== undefined) {
                        parts.push(`type ${config.type};`);
                    }
                    if (config.auth !== undefined && config.auth.length > 0) {
                        parts.push(`authentication cryptographic;
password "${config.auth}" {
algorithm hmac sha512;
};`);
                    }

                    parts.push("};"); // end of interface

                    return parts.join("\n");
                }
            );

            return `area ${areaId} {
${interfacePart.join("\n")}
};`;
        })
        .join("\n");
}

function formatBDFConfig(bfdConfig: Record<string, BFDConfig>) {
    return Object.entries(bfdConfig)
        .map(([interfaceName, config]) => {
            const parts = [`interface "${interfaceName}" {`];

            const useRx = config.rxMs ?? config.intervalMs;
            const useTx = config.txMs ?? config.intervalMs;

            if (useRx !== undefined) {
                parts.push(`min rx interval ${useRx} ms;`);
            }
            if (useTx !== undefined) {
                parts.push(`min tx interval ${useTx} ms;`);
            }

            if (config.idleMs !== undefined) {
                parts.push(`idle tx interval ${config.idleMs} ms;`);
            }
            if (config.multiplier !== undefined) {
                parts.push(`multiplier ${config.multiplier};`);
            }

            parts.push("};"); // end of interface

            return parts.join("\n");
        })
        .join("\n");
}

function simpleFormatBirdConfig(configText: string) {
    const output: string[] = [];
    let level = 0;

    for (const line of configText.split("\n")) {
        const sline = line.trim();
        if (sline.startsWith("#")) {
            output.push(line);
            continue;
        }

        if (sline.startsWith("}")) {
            level = Math.max(0, level - 1);
        }
        output.push("  ".repeat(level) + sline);
        if (sline.endsWith("{")) {
            level++;
        }
    }

    return output.join("\n");
}

export function FormatBirdConfig(options: {
    routerId?: string;
    directInterfaceNames: string[];
    ospfImportExcludeCIDRs: string[];
    ospfExportExcludeCIDRs: string[];
    ospfAreaConfig: Record<string, Record<string, CommonOSPFConfig>>;
    bfdConfig: Record<string, BFDConfig>;
    debugProtocols?: boolean; // default to false
    disableLogging?: boolean; // default to false
    gitVersion?: string;
}) {
    const currentTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
    const routerIdText =
        options.routerId !== undefined ? `router id ${options.routerId};` : "";
    const debugProtocolsText =
        options.debugProtocols === true
            ? "debug protocols all;"
            : "#debug protocols all;";
    const logConfigText =
        options.disableLogging === true
            ? "#log stderr all;"
            : "log stderr all;";

    const directInterfaceText = options.directInterfaceNames
        .map((n) => `interface "${n}";`)
        .join("\n");
    const { defineText: importDefineText, filterText: importFilterText } =
        formatLocalNetAndFilter(
            "LOCALNET_NO_IMPORTSET",
            "import",
            options.ospfImportExcludeCIDRs
        );
    const { defineText: exportDefineText, filterText: exportFilterText } =
        formatLocalNetAndFilter(
            "LOCALNET_NO_EXPORTSET",
            "export",
            options.ospfExportExcludeCIDRs
        );

    const ospfAreaConfigText = formatOSPFConfig(
        options.ospfAreaConfig,
        options.bfdConfig
    );
    const bfdConfigText = formatBDFConfig(options.bfdConfig);

    const finalOutput = `# Auto generated by lspnet-tools at ${currentTime}
# version: ${options.gitVersion ?? "lspnet-tools-node"}

${importDefineText}
${exportDefineText}

${logConfigText}

${routerIdText}

${debugProtocolsText}

protocol device {}

protocol bfd {
    ${bfdConfigText}
}

protocol direct {
    ipv4;
    ${directInterfaceText}
}

protocol kernel {
    ipv4 {
        import none;
        export where proto = "wg";
    };
}

protocol ospf v2 wg {
    ecmp yes;
    merge external yes;
    ipv4 {
        ${importFilterText};
        ${exportFilterText};
    };
    
    ${ospfAreaConfigText}
}
`;
    return simpleFormatBirdConfig(finalOutput);
}
