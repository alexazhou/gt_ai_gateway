import ormService from "../../service/ormService";

/**
 * 单条 SQL 允许绑定的参数个数上限，按运行模式取保守值。
 *
 * - **D1（worker 模式）**：D1 硬上限是 **100** 个绑定参数，超了直接报错。这里取 **90**，
 *   留 10% 余量 —— 调用方拼条件时可能再多带一两个参数（例如额外的 `AND tenant_id = ?`），
 *   贴着 100 走就会在那种场景下偶发越界。
 * - **better-sqlite3 / MySQL（node 模式）**：上限高得多（SQLite 旧版 999 / 新版 32766、
 *   MySQL 65535），取 500 —— 少 4 倍往返次数，离任何一档上限都还有余量。
 *
 * 用途：`WHERE id IN (...)` 这类按待查集合拼参数的地方不能一次塞进整页，必须先按本函数分批。
 * 写成函数而不是常量，是因为同一个部署包可能跑在两种模式下。
 *
 * 模式未初始化时 ormService 默认是 WORKER，返回 90 —— 取值偏小只会多几次往返，不会报错。
 */
const D1_MAX_BIND_PARAMS = 90;
const DEFAULT_MAX_BIND_PARAMS = 500;

export function bindParamBatchSize(): number {
    return ormService.isWorker ? D1_MAX_BIND_PARAMS : DEFAULT_MAX_BIND_PARAMS;
}
