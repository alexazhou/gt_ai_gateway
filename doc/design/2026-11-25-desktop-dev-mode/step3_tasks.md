# Desktop Dev Mode — 开发任务表

> 状态：待实施

## 任务拆分

| 编号 | 模块 | 任务描述 | 涉及文件 | 状态 |
|------|------|----------|----------|------|
| T1 | Tauri (Rust) | 在 `utils.rs` 中实现自定义数据目录解析（含 `~` 展开、存在性与目录类型校验）与 `normalize_log_level` 纯函数，并补充 Rust 单元测试 | `tauri/src-tauri/src/utils.rs` | 待办 |
| T2 | Tauri (Rust) | 在 `lib.rs` 中接入 `GT_AI_GATEWAY_DATA_DIR` 目录解析，扩展 `AppConfig` / `read_config` / `BackendLaunchConfig` 支持 `log_level`（默认 `"info"`），并在 `start_backend_process` 中向后端传入 `LOG_LEVEL` 环境变量 | `tauri/src-tauri/src/lib.rs` | 待办 |
| T3 | 后端 Logger | 1. 在 `loggerUtil.ts` 与 `local.ts` 中支持 `LOG_LEVEL`（`debug` / `info` / `warn` / `error`，默认 `info`）级别阈值过滤，提供 `shouldLog` / `isDebugEnabled` 方法；<br>2. 修复 `loggerUtil.ts` 跨天切换（`rollOverIfNewDay`）与启动初始化时未触发 `pruneOldFiles()` 的缺陷，确保按天滚动同样遵守 `maxFileCount`（5 个）上限 | `src/util/loggerUtil.ts`<br>`src/local.ts` | 待办 |
| T4 | 流式 Chunk 日志 | 在 `streamLogService.ts` 与 `responseHandlerService.ts` 中支持按日志级别输出上游 chunk：`info` 默认输出采样摘要（第 1 个及每 200 个 chunk），`debug` 自动输出每个上游 chunk 的完整内容 | `src/service/streamLogService.ts`<br>`src/service/responseHandlerService.ts` | 待办 |
| T5 | 测试与文档 | 补充 `loggerUtil` 与 `streamLogService` 单元测试，更新 `doc/dev/TauriDevManual.md` 与 `doc/dev/BackendDevManual.md` 中的配置与环境变量说明 | `tests/unit/`<br>`doc/dev/TauriDevManual.md`<br>`doc/dev/BackendDevManual.md` | 待办 |

## 依赖关系

- `T1` → `T2`（`lib.rs` 依赖 `utils.rs` 中的路径解析与日志级别归一化函数）
- `T3` → `T4`（流式 chunk 的 `debug` / `info` 分级输出依赖 `loggerUtil` 的级别判断能力）
- `T1 + T2` 与 `T3 + T4` 可并行开发，最后汇合至 `T5` 验证

## 验收清单

- [ ] `cargo test`（`tauri/src-tauri`）全部通过
- [ ] `npm run backend:test:type` 静态类型检查通过
- [ ] 新增的日志级别过滤与流式 chunk 输出单元测试全部通过
- [ ] `doc/dev/TauriDevManual.md` 已同步更新 `GT_AI_GATEWAY_DATA_DIR` 与 `config.json` 的 `log_level` 说明
