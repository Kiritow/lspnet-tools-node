import { getOrInitNodeInteractive } from "cli-api";
import { Command } from "commander";
import assert from "node:assert";
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

program.parse();
