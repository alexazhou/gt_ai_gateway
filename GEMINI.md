# 说明

## 文档索引

本文档介绍项目相关的各类文档及其用途：

| 文档 | 说明 |
|------|------|
| **GEMINI.md** | 本文档，编程规范和工作技巧 |
| **doc/FrontendDevManual.md** | 前端开发手册，包含环境配置、前端开发方式等 |
| **doc/BackendDevManual.md** | 后端开发手册，包含环境配置、后端开发方式、API 开发等 |
| **doc/TestManual.md** | 测试手册，描述测试环境的架构设计和操作流程 |
| **doc/LlmApiUsage.md** | LLM API 使用指南，介绍如何调用网关提供的 LLM 接口 |
| **doc/OpenAiProtocol.md** | OpenAI 协议说明文档 |
| **doc/AnthropicProtocol.md** | Anthropic 协议说明文档 |
| **doc/StreamLogging.md** | 流式日志相关说明 |
| **doc/design/Frontend_Product_Documentation.md** | 前端产品文档 |
| **doc/design/Frontend_Roadmap.md** | 前端路线图 |
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

## Git 提交规范
1. **禁止提交本地数据和工具配置文件**：在执行 `git commit` 前，务必检查并排除以下内容：
    - **本地数据库**：`local.db`、`test.db` 等
    - **IDE/工具配置**：`.claude/**`、`.gemini/**`、`.idea/`、`.vscode/` 等
    - **演示/临时文件**：`upstream_demo.txt`、各种 `.txt` 或临时测试脚本
2. **提交前自检**：使用 `git status` 确认待提交的文件列表，确保只包含核心代码逻辑和必要的文档改动。
3. **强制推送警告**：除非是为了修复错误的提交（如误删、误传敏感信息且尚未被他人拉取），否则避免使用 `git push --force`。
4. 在提交之前，需要执行所有后端自动化测试用例，和一次前端构建。避免提交失败的代码

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
