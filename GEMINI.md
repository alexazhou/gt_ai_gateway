# 说明

## 文档索引

本文档介绍项目相关的各类文档及其用途：

| 文档 | 说明 |
|------|------|
| **GEMINI.md** | 本文档，编程规范和工作技巧 |
| **doc/dev/FrontendDevManual.md** | 前端开发手册，包含环境配置、前端开发方式等 |
| **doc/dev/BackendDevManual.md** | 后端开发手册，包含环境配置、后端开发方式、API 开发等 |
| **doc/deploy/DockerDeployment.md** | Docker 部署文档，包含 Docker Compose、直接构建运行等 |
| **doc/dev/TauriDevManual.md** | Tauri 桌面应用开发手册，包含目录结构、启动流程、Dev/Production 差异、已知问题等 |
| **doc/dev/TestManual.md** | 测试手册，描述测试环境的架构设计和操作流程 |
| **doc/usage/LlmApiUsage.md** | LLM API 使用指南，介绍如何调用网关提供的 LLM 接口 |
| **doc/usage/ProtocolConversion.md** | 自动协议转换说明文档，介绍网关如何自动在 OpenAI 和 Anthropic 协议间转换 |
| **doc/protocol/OpenAiProtocol.md** | OpenAI Chat Completions 协议说明文档 |
| **doc/protocol/OpenAiResponsesProtocol.md** | OpenAI Responses API 协议说明文档 |
| **doc/protocol/AnthropicProtocol.md** | Anthropic 协议说明文档 |
| **doc/StreamLogging.md** | 流式日志相关说明 |
| **doc/design/versions/版本文档规范.md** | 版本文档规范：版本管理、文档命名规范、新增版本流程 |
| **doc/design/versions/ROADMAP.md** | 实施路线图，按发布版本（前两位）概述各版本里程碑能力 |
| **doc/design/versions/v1.0/ … v1.9/** | 各版本开发文档（product 产品 / technical 技术 / tasks 任务）与落地功能的专项设计，按实际发布版本组织 |
| **doc/design/versions/_planning/** | 规划中的设计稿（尚未实施），目前为空 |
| **doc/tech/concurrent_request_fix.md** | 并发请求问题修复记录 |
| **doc/tech/record_timestamp_serialization_fix.md** | 请求记录时间字段序列化修复说明 |
| **doc/tech/release_process.md** | 新版本发布流程，包含版本号修改、提交流程、tag 和 push 步骤 |

## 编程规范
1. 代码使用 4 个空格缩进，每个方法之间空两行
2. 程序使用 MVC 架构，主要由以下几个模块组成:
    1. 业务逻辑放到 service 层中
    2. controller 层只包含简单逻辑和调用 service
    3. model 层包含数据模型，以及数据模型本身的计算逻辑
    4. 跟业务无关的静态方法，放到 utils 中
    5. 常量定义都放在 constants 中
3. api 使用 rest 风格，url 都以 .json 结尾
4. 不要用 ORM 内置的 findOrFail 方法（会导致返回 404 而不是 json），需要的时候只使用 find 然后通过 if 判断结果处理
5. 统一使用默认导出（default export），调用时使用 `模块名.方法名` 的方式，这样可以明确知道调用的是哪个模块的代码
    - **导入方式**：`import xxxHelper from '../helpers/xxxHelper'`
    - **调用方式**：`xxxHelper.someMethod()`
    - 所有代码，包括测试相关的模块（fixtures、helpers、config）都必须遵循此规范

## 工作技巧
1. 在执行单条测试用例的时候（如果日志不是特多），不要用 grep 过滤日志，直接查看整个用例的全部输出，这样更容易定位问题
2. 禁止使用 explore agent 探索代码，自己直接读文件、搜索即可

## 本地数据与日志
1. 本地 Node 模式运行时，业务数据默认存放在项目根目录的 `local.db`
2. 本地日志默认存放在 `log/` 目录下
    1. 应用日志通常在 `log/app-YYYY-MM-DD.log`
    2. 测试日志通常在 `log/test/`
    3. 如果启用原始流日志，会写到 `log/stream/`
3. `local.db` 和 `log/` 已加入 `.gitignore`。因此 agent 在默认文件上下文里可能看不到这些文件，需要使用 bash 工具显式读取，例如 `ls log`、`tail -n 200 log/test/app.log`、`sqlite3 local.db ...`

## Git 提交规范
1. **禁止提交本地数据和工具配置文件**：在执行 `git commit` 前，务必检查并排除以下内容：
    - **本地数据库**：`local.db`、`test.db` 等
    - **IDE/工具配置**：`.claude/**`、`.gemini/**`、`.idea/`、`.vscode/` 等
    - **演示/临时文件**：`upstream_demo.txt`、各种 `.txt` 或临时测试脚本
2. **提交前自检**：使用 `git status` 确认待提交的文件列表，确保只包含核心代码逻辑和必要的文档改动。
3. **强制推送警告**：除非是为了修复错误的提交（如误删、误传敏感信息且尚未被他人拉取），否则避免使用 `git push --force`。
4. 在提交之前，需要执行后端的 node 模式自动化测试用例（worker 模式由于较慢，留待 CI 环境自动运行）、TypeScript 静态类型检查（`npm run backend:test:type`），以及一次前端构建。避免提交失败的代码
5. **禁止自动提交**：必须在明确得到用户的要求或允许后才能执行 `git commit`。即使代码已经完成且测试通过，也应当先告知用户状态，等待用户指示后再提交。
6. **禁止自动推送**：`git commit` 后必须等待用户明确指示才能执行 `git push`，不得自动推送。
7. **禁止 AI 署名**：提交信息中不得包含任何 AI 工具相关字样（如 `claude`、`Co-Authored-By: Claude` 等）。`script/githook/pre-commit` 会拦截含此类字样的提交信息。

## 测试文档
...
Test.md 文档描述了测试环境的完整生命周期和操作流程，包括：

1. **测试运行方法**: 运行测试的命令，和用例失败排查方法
2. **全局生命周期**：Setup（初始化）→ Test Execution（测试执行）→ Teardown（清理）
2. **时间点流程**：详细列出了每个阶段的具体操作、执行顺序和调用位置
3. **数据库操作**：数据库文件的创建/删除、migrations 执行逻辑、数据表的清理
4. **数据隔离**：每个测试类开始时自动清空所有数据表，测试类之间互不影响
5. **配置选项**：测试相关的环境变量和配置参数
6. **Mock AI 服务器**：模拟 OpenAI 和 Anthropic API 的 mock 服务器配置

运行测试前，请参考该文档了解测试相关内容
