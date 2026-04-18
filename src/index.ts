import assert from "node:assert";
import { Command } from "@commander-js/extra-typings";
import dayjs from "dayjs";
import { getOrInitNodeInteractive } from "./cli-api";
import { ServiceMain } from "./service";
import { GIT_COMMIT_HASH, BUILD_TIME } from "./version";

const program = new Command();

program
    .name("lspnet-tools-node")
    .description("LSPNet Tools NodeJS Version")
    .version(
        `${GIT_COMMIT_HASH} (Built at ${dayjs(BUILD_TIME).format("YYYY-MM-DD HH:mm:ssZZ")})`
    );

program
    .command("init")
    .description("Initialize configuration (create new node)")
    .requiredOption("-d, --database <path>", "Path to database file")
    .action(async (options) => {
        const database = options.database;
        assert(
            database !== undefined && typeof database === "string",
            "Database path is required"
        );
        await getOrInitNodeInteractive(database);
    });

program
    .command("run")
    .description("Run the node program")
    .requiredOption("-d, --database <path>", "Path to database file")
    .action((options) => {
        const database = options.database;
        assert(
            database !== undefined && typeof database === "string",
            "Database path is required"
        );
        ServiceMain(database).catch((err) => {
            console.error("Fatal error in ServiceMain:", err);
            process.exit(1);
        });
    });

program.parse();
