# Security Policy

## Reporting

安全问题请使用 GitHub Private Vulnerability Reporting。不要在公开 Issue 中提交 API key、token、cookie、私钥、OpenCode 用户配置、Session 数据或包含私有模型与服务信息的日志。

## Security Model

- `.o4e/` 是用户可编辑配置源，`.opencode/` 是生成运行时。
- Agent 工具、MCP、权限、委派目标、Effect、Scope Lock 和 Workflow Gate 由运行时代码执行，不能依赖 Prompt 作为安全边界。
- Background Task 和 Workflow 的持久化授权无法验证时必须 fail closed。
- 当前调度和 Scope Lock 仅在单个 OpenCode 进程内协调；同一目标项目不支持多进程并发执行。
