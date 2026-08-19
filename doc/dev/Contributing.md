# 参与贡献 (Contributing)

欢迎来到 GT AI Gateway！非常感谢你对本项目的关注与支持。我们非常欢迎各种形式的 Pull Request (PR)，无论是修复 Bug、完善文档、增加新特性，还是添加更多常用的大模型供应商预设。

## 提交 PR 的一般流程

1. **Fork 本仓库**：点击页面右上角的 Fork 按钮，将代码仓库 Fork 到你的个人账户下。
2. **克隆代码**：将你 Fork 的仓库克隆到本地。
   ```bash
   git clone https://github.com/你的用户名/gt_ai_gateway.git
   ```
3. **创建分支**：基于 `master` 分支创建一个新的特性分支。
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **提交代码**：完成修改后，提交你的代码。请确保提交信息清晰明了，**并使用英文撰写提交信息（subject 和 body 均用英文）**。
5. **推送到远端**：将你的分支推送到你 Fork 的仓库。
   ```bash
   git push origin feature/your-feature-name
   ```
6. **发起 Pull Request**：在 GitHub 页面上发起一个 Pull Request，并在描述中简要说明你的修改内容。

---

## 常见贡献场景：如何添加供应商预设？

如果在使用过程中，你发现系统内置的供应商预设（Vendor Presets）中没有你常用的平台（比如你想添加“智谱”大模型），你可以非常轻松地通过 PR 将其补充进来，造福更多开发者！

要添加一个新的供应商预设，你**完全不需要修改前端代码或数据库**，只需修改后端的两个文件即可：

### 1. 注册新的 Vendor Type

打开 `src/constants.ts` 文件，找到 `VendorType` 枚举，在其中加上新供应商的唯一标识符（请使用小写字母）：

```typescript
export enum VendorType {
    ALIYUN = "aliyun",
    // ... 其他现有的预设 ...
    ZHIPU = "zhipu", // <- 增加你的新供应商标识
    OTHER = "other",
}
```

### 2. 配置供应商预设 URL

打开 `src/config/vendorDefaultUrls.json` 文件，使用刚刚定义的标识符（如 `zhipu`）作为键名，加上对应的显示名称和 API 基础地址（Base URL）：

```json
{
    // ... 其他现有的预设 ...
    "zhipu": {
        "label": "智谱 (Zhipu)",
        "openai": "https://open.bigmodel.cn/api/paas/v4"
    },
    "other": {
        "label": "Other"
    }
}
```

**字段说明：**
- `label`: 将在前端下拉列表中显示的友好名称。
- `openai`: 如果该供应商支持 OpenAI 规范，请填写对应的 Base URL。
- `anthropic`: 如果该供应商支持 Anthropic 规范，请填写对应的 Base URL。

> **提示**：前端界面在打开“新建/编辑供应商”时，会自动调用接口动态读取 `vendorDefaultUrls.json`。因此只要你修改了这两个后端文件，该预设就会自动出现在前端的下拉列表中，并且用户在选择该供应商后，能自动填入默认的基础地址！

完成以上两步后，就可以提交你的修改并向我们发起 PR 了！感谢你的卓越贡献！
