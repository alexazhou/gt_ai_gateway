import { sutando } from "sutando";
import config from "../config";
import ormService from "../../src/service/ormService";
import { RunMode } from "../../src/constants";


let connected = false;


async function connectNodeOrm(): Promise<void> {
    ormService.mode = RunMode.NODE;

    if (connected) {
        return;
    }

    if (config.DB_CONFIG.driver === "mysql") {
        // MySQL：与测试服务器共用同一 MySQL 库
        const m = config.DB_CONFIG.mysql;
        sutando.addConnection({
            client: "mysql2",
            connection: {
                host: m.host,
                port: m.port,
                user: m.user,
                password: m.password,
                database: m.database,
            },
            // 静默 knex 对 mysql 不支持 .returning() 的警告
            log: {
                warn: () => {},
                deprecate: () => {},
                debug: () => {},
            },
            useNullAsDefault: true,
        });
    } else {
        sutando.addConnection({
            client: "better-sqlite3",
            connection: {
                filename: config.DB_CONFIG.path,
            },
            useNullAsDefault: true,
        });
    }

    connected = true;
}


export default {
    connectNodeOrm,
};
