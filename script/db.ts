import dbMigrationService from "../src/service/dbMigrationService";
import { DBAdapter } from "../src/util/db/dbAdapter";

const args = process.argv.slice(2);

// 解析命令行参数
let command = "";
let env = "node"; // default
let dbConfigPath = ""; // optional custom wrangler config
let dbName = "DB"; // default D1 binding name

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" || args[i] === "-e") {
        env = args[i + 1];
        i++;
    } else if (args[i] === "--config" || args[i] === "-c") {
        dbConfigPath = args[i + 1];
        i++;
    } else if (args[i] === "--db-name") {
        dbName = args[i + 1];
        i++;
    } else if (!command) {
        command = args[i];
    }
}

// 主入口
async function main() {
    if (!command) {
        console.error(
            "Usage: npx tsx script/db.ts <command> [--env node|worker-local|worker-cloud]",
        );
        console.error("Commands: migrate, status, clear, init");
        process.exit(1);
    }

    if (!["node", "worker-local", "worker-cloud"].includes(env)) {
        console.error(
            `Invalid environment: ${env}. Must be node, worker-local, or worker-cloud.`,
        );
        process.exit(1);
    }

    console.log(`=== DB Automation Script ===`);
    console.log(`Command: ${command}`);
    console.log(`Environment: ${env}`);
    console.log(`============================\n`);

    let adapter: DBAdapter;
    try {
        adapter = dbMigrationService.createDBAdapter(env, {
            configPath: dbConfigPath,
            dbName,
        });
    } catch (e: any) {
        console.error("Failed to initialize database adapter:", e.message);
        process.exit(1);
    }

    try {
        switch (command) {
            case "migrate":
                await dbMigrationService.migrate(adapter, env, { dbName, configPath: dbConfigPath });
                break;
            case "status":
                await dbMigrationService.status(adapter, env);
                break;
            case "clear":
                await dbMigrationService.clear(adapter, env);
                break;
            case "init":
                await dbMigrationService.init(adapter, env);
                break;
            default:
                console.error(`Unknown command: ${command}`);
                console.log("Available commands: migrate, status, clear, init");
                process.exit(1);
        }
    } catch (e) {
        console.error("\nExecution failed:");
        console.error(e);
        process.exit(1);
    } finally {
        adapter.close();
        await dbMigrationService.clearTempDir?.();
    }
}

// Only run main() if this file is executed directly as a CLI script.
// require.main === module is unreliable when bundled with esbuild (always true at top level).
// Use argv[1] instead: when run as `npx tsx script/db.ts`, argv[1] contains 'db.ts'.
const _scriptPath = process.argv[1] || "";
if (_scriptPath.endsWith("db.ts") || _scriptPath.endsWith("db.js") || _scriptPath.includes("/script/db")) {
    main();
}
