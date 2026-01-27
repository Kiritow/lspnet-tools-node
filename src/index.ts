import assert from "node:assert";
import { Command } from "@commander-js/extra-typings";
import { getOrInitNodeInteractive } from "./cli-api";
import { ServiceMain } from "./service";

const program = new Command();

program
    .name("lspnet-tools-node")
    .description("LSPNet Tools NodeJS Version")
    .version("0.0.1");

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
