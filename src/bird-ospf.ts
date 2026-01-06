import assert from "node:assert";
import { sudoCallOutput } from "./utils";

function getBlockLevel(line: string) {
    const match = line.match(/^(\t*)/);
    return match !== null ? match[1].length : 0;
}

export class PeekableLineReader {
    private lines: string[];
    private index: number;

    constructor(lines: string[]) {
        this.lines = lines;
        this.index = 0;
    }

    pop() {
        if (this.index >= this.lines.length) {
            return undefined;
        }
        const line = this.lines[this.index];
        this.index += 1;
        return {
            line,
            sline: line.trim(),
            blevel: getBlockLevel(line),
        };
    }

    peek() {
        if (this.index >= this.lines.length) {
            return undefined;
        }
        const line = this.lines[this.index];
        return {
            line,
            sline: line.trim(),
            blevel: getBlockLevel(line),
        };
    }
}

export interface RouterInfo {
    // OSPFv2
    routerId: string;
    distance: number;
    vlinks: { routerId: string; metric: number }[]; // virtual links
    routers: { routerId: string; metric: number }[];
    stubnets: { network: string; metric: number }[];
    xnetworks: { network: string; metric: number }[]; // summary of external networks from other areas
    xrouters: { routerId: string; metric: number }[]; // summary of external routers from other areas
    externals: {
        network: string;
        metric: number;
        metricType: number;
        via?: string;
        tag?: string;
    }[];
    nssaExternals: {
        network: string;
        metric: number;
        metricType: number;
        via?: string;
        tag?: string;
    }[];
}

function parseOSPFRouter(reader: PeekableLineReader) {
    const routerInfo: RouterInfo = {
        routerId: "",
        distance: 0,
        vlinks: [],
        routers: [],
        stubnets: [],
        xnetworks: [],
        xrouters: [],
        externals: [],
        nssaExternals: [],
    };

    for (;;) {
        const nextLine = reader.peek();
        if (nextLine === undefined) break;
        const { line, sline, blevel } = nextLine;
        if (sline.length < 1) {
            reader.pop();
            continue;
        }
        if (blevel < 2) {
            break;
        }
        reader.pop(); // consume line

        assert(blevel === 2, `Expected level 2 line, got level: ${blevel}`);
        if (sline.startsWith("distance ")) {
            const distance = parseInt(sline.split(" ")[1], 10);
            assert(!isNaN(distance), `Invalid distance value: ${sline}`);
            routerInfo.distance = distance;
        } else if (sline.startsWith("vlink ")) {
            const parts = sline.split(" ");
            assert(
                parts.length === 4 && parts[2] === "metric",
                `Invalid vlink line: ${sline}`
            );
            const routerId = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid vlink metric value: ${sline}`);
            routerInfo.vlinks.push({ routerId, metric });
        } else if (sline.startsWith("router ")) {
            const parts = sline.split(" ");
            assert(
                parts.length === 4 && parts[2] === "metric",
                `Invalid router line: ${sline}`
            );
            const routerId = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid router metric value: ${sline}`);
            routerInfo.routers.push({ routerId, metric });
        } else if (sline.startsWith("stubnet ")) {
            const parts = sline.split(" ");
            assert(
                parts.length === 4 && parts[2] === "metric",
                `Invalid stubnet line: ${sline}`
            );
            const network = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid stubnet metric value: ${sline}`);
            routerInfo.stubnets.push({ network, metric });
        } else if (sline.startsWith("xnetwork ")) {
            const parts = sline.split(" ");
            assert(
                parts.length === 4 && parts[2] === "metric",
                `Invalid xnetwork line: ${sline}`
            );
            const network = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid xnetwork metric value: ${sline}`);
            routerInfo.xnetworks.push({ network, metric });
        } else if (sline.startsWith("xrouter ")) {
            const parts = sline.split(" ");
            assert(
                parts.length === 4 && parts[2] === "metric",
                `Invalid xrouter line: ${sline}`
            );
            const routerId = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid xrouter metric value: ${sline}`);
            routerInfo.xrouters.push({ routerId, metric });
        } else if (sline.startsWith("external ")) {
            const parts = sline.split(" ");
            const network = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid external metric value: ${sline}`);
            const metricType =
                parts.find((p) => p === "metric2") !== undefined ? 2 : 1;
            const via =
                parts.find((p) => p === "via") !== undefined
                    ? parts[parts.indexOf("via") + 1]
                    : undefined;
            const tag =
                parts.find((p) => p === "tag") !== undefined
                    ? parts[parts.indexOf("tag") + 1]
                    : undefined;

            routerInfo.externals.push({
                network,
                metric,
                metricType,
                via,
                tag,
            });
        } else if (sline.startsWith("nssa-ext ")) {
            const parts = sline.split(" ");
            const network = parts[1];
            const metric = parseInt(parts[3], 10);
            assert(!isNaN(metric), `Invalid external metric value: ${sline}`);
            const metricType =
                parts.find((p) => p === "metric2") !== undefined ? 2 : 1;
            const via =
                parts.find((p) => p === "via") !== undefined
                    ? parts[parts.indexOf("via") + 1]
                    : undefined;
            const tag =
                parts.find((p) => p === "tag") !== undefined
                    ? parts[parts.indexOf("tag") + 1]
                    : undefined;

            routerInfo.nssaExternals.push({
                network,
                metric,
                metricType,
                via,
                tag,
            });
        } else {
            console.warn(`unknown line in OSPF router: ${line}`);
        }
    }

    return routerInfo;
}

function parseOSPFArea(reader: PeekableLineReader) {
    const routers: RouterInfo[] = [];
    for (;;) {
        const nextLine = reader.peek();
        if (nextLine === undefined) break;
        const { line, sline, blevel } = nextLine;
        if (sline.length < 1) {
            reader.pop();
            continue;
        }
        if (blevel < 1) {
            break;
        }
        reader.pop(); // consume line

        assert(blevel === 1, `Expected level 1 line, got level: ${blevel}`);
        if (sline.startsWith("router ")) {
            const routerId = sline.split(" ")[1];
            const routerInfo = parseOSPFRouter(reader);
            routerInfo.routerId = routerId;
            routers.push(routerInfo);
        } else {
            console.warn(`unknown line in OSPF area: ${line}`);
        }
    }

    return routers;
}

export function parseOSPFState(reader: PeekableLineReader) {
    const areaRouterMap = new Map<string, RouterInfo[]>();
    const otherASBRs: RouterInfo[] = [];

    for (;;) {
        const nextLine = reader.pop();
        if (nextLine === undefined) break;
        const { line, sline, blevel } = nextLine;
        if (sline.length < 1) {
            continue;
        }

        assert(blevel === 0, `Expected top level line, got level: ${blevel}`);
        if (sline.startsWith("area ")) {
            const currentArea = sline.split(" ")[1];
            const areaRouters = parseOSPFArea(reader);
            areaRouterMap.set(currentArea, areaRouters);
        } else if (sline.startsWith("other ASBRs")) {
            const areaRouters = parseOSPFArea(reader);
            otherASBRs.push(...areaRouters);
        } else {
            console.warn(`unknown line in OSPF state: ${line}`);
        }
    }

    return {
        areaRouterMap,
        otherASBRs,
    };
}

export async function GetRouterOSPFState(containerIdOrName: string) {
    const output = await sudoCallOutput([
        "podman",
        "exec",
        "-it",
        containerIdOrName,
        "birdc",
        "show",
        "ospf",
        "state",
        "all",
    ]);
    const reader = new PeekableLineReader(output.split("\n"));
    return parseOSPFState(reader);
}
