/**
 * 子进程探针：在一个**全新空库**上跑生产启动路径 `ormService.init()`，然后退出。
 *
 * 为什么必须开子进程（#382 验收打回点 1）：
 *   `ensureSystemRules()` 在 node 形态下挂在 `ormService.init()` 里，是**进程启动期**的一次性动作。
 *   测试进程里 `ormService` 是单例、早已连上共享的 `test.db`，再 `init()` 一次既会污染共享库，
 *   也测不到「全新库启动」这件事；而走 `dbHelper.truncate()` 又会被它自己的 `seedSystemRules()`
 *   （显式调 ensure）遮住——于是把 init 里那行 ensure 删掉，全套门依然全绿（实测）。
 *   所以这里另起一个进程、另给一个空库文件，完全按生产路径初始化。
 *
 * 由 `tests/lifecycle/systemRulesStartup.node.test.ts` 拉起，参数是 sqlite 库文件绝对路径。
 * 断言在父进程做（直接读库文件），本探针只负责「按生产路径初始化」并报告成败。
 */
import { writeSync } from "fs";
import ormService from "../../src/service/ormService";
import { RunMode } from "../../src/constants";

async function main(): Promise<void> {
    const dbPath = process.argv[2];
    if (!dbPath) {
        writeSync(2, "usage: tsx tests/helpers/ormInitProbe.ts <sqlite-db-path>\n");
        process.exit(2);
    }

    await ormService.init({ mode: RunMode.NODE, dbPath });
    // 用 writeSync 而不是 console.log：随后立刻 process.exit，管道上的异步 stdout 可能被截断
    writeSync(1, "ORM_INIT_OK\n");
    process.exit(0);
}

main().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeSync(2, `ORM_INIT_FAILED ${detail}\n`);
    process.exit(1);
});
