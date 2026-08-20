# V1.1: 厂商预置与部署完善 - 产品文档

## 目标

扩充内置供应商类型覆盖，并完善 Docker 部署体验，让网关更易于对接国内云厂商和直接部署运行。

## 功能特性

- **新增厂商预置**：aliyun、aliyun_coding、volcengine_coding 等内置供应商类型，Anthropic URL 自动补全
- **Docker 部署**：解决 better-sqlite3 等 native module 编译问题，保证生产镜像可直接运行
- **数据库配置**：支持通过 `DB_PATH` 环境变量指定数据库文件位置

## 验收标准

- [ ] 新增厂商类型可正常创建供应商并自动补全 URL
- [ ] Docker 镜像构建成功，容器启动后网关可用
- [ ] 通过 `DB_PATH` 可指定数据库路径

## 相关文档

- 基础能力见 [V1.0 产品文档](../2026-03-13-basic-gateway/step1_product.md) 与 [V1.0 技术文档](../2026-03-13-basic-gateway/step2_technical.md)
