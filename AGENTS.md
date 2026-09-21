# AGENTS.md — repository root

本文件只提供 AI 阅读与任务路由，不维护第二份产品或工程契约。

## 必须先读

1. [SPEC.md](./SPEC.md)：本仓库唯一的产品与工程契约，包含契约优先级、需求和验收要求。
2. [CONTRIBUTING.md](./CONTRIBUTING.md)：开发、验证、提交和协作流程。

实现、Schema、测试和 CLI 是当前行为的证据，不是降低 SPEC 要求的依据。发现差异时，按 SPEC 的契约权威与真实性规则处理；不要在本文件复制平台、Shell、权限、预算、超时、恢复或配置默认值。

## 按任务定位

| 任务 | 阅读入口 | 实现与验证入口 |
| --- | --- | --- |
| 产品边界与验收 | `SPEC.md` | 对应需求条目的验收依据 |
| 安装、构建与卸载 | `README.zh-cn.md`、`docs/reference/cli.md` | `scripts/installer.mjs`、`src/runtime-builder.mjs`、安装器与构建测试 |
| 配置、Agent 与 Plan | SPEC 的 `CFG`、`BLD`、`AGT` 条款，`defaults/.o4e/README.md` | `defaults/.o4e/schemas/`、`src/core/`、`src/runtime-builder.mjs` |
| 委派、后台任务与 Workflow | SPEC 对应需求章节 | `src/runtime/`、`src/core/`、对应行为测试 |
| 跨平台命令执行 | SPEC 的 `CMD` 条款 | `src/command-core/`、`src/adapters/opencode/`、`src/runtime/command-task-runtime.mjs`、命令执行与生命周期测试 |
| Prompt、Skill 与 Soul | SPEC 的 `PRM`、`INS` 条款，`defaults/.o4e/README.md` | `defaults/.o4e/`、提示词组装、安装器与插件测试 |
| 公开文档 | `docs/README.md`、`README.md`、`README.zh-cn.md` | 对应需求、实现、Schema、CLI 和实际验证证据 |

## 目录入口

- `defaults/.o4e/`：默认配置与资源。
- `src/`：实现。
- `scripts/`：安装、构建和注册工具。
- `test/`：验证。
- `docs/`：公开使用与贡献文档。

命令、维护约束和交付要求见 `SPEC.md` 与 `CONTRIBUTING.md`，不在此重复维护。
