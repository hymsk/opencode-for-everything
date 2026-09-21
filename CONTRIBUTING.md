# Contributing

## 开发流程

1. 开始前读取 [AGENTS.md](AGENTS.md) 和 [SPEC.md](SPEC.md)。
2. 保持改动聚焦，不覆盖任务范围外的工作区改动，不手工编辑 `.opencode/` 生成物。
3. 配置、Schema、Agent、Prompt 或 Skill 的默认源只修改 `defaults/.o4e/`；运行时实现修改 `src/`，安装和构建行为修改 `scripts/`。
4. 新增或修改行为时保留正常路径、关键权限边界、持久化、恢复、并发和失败路径的最小行为代表；相同校验在一层验证，其余入口只保留接线覆盖。不保留固定文案、源码拼法、内部计数、简单转发或已被更强行为测试覆盖的重复用例。

## 验证

开发与测试使用 Node.js 24（测试直接加载 TypeScript server 入口）；安装器的 Node.js 下限为 20.12。OpenCode 验证基线为 `>=1.18.21`，CI 使用 1.18.21 作为固定验证版本；具体实机记录保留实际版本，不代表范围内每个版本都已验证。项目开发于 Linux，其他平台的 CI 结果不能替代完整真实宿主生命周期验收。

```bash
npm test
npm run test:verbose
```

`npm test` 使用精简 reporter：成功时只输出最终汇总和最多 10 个超过 1 秒的慢用例，失败时保留对应测试的 stdout、stderr 和错误诊断。长跑期间默认不打印进度，以避免成功项污染日志；需要逐项进度时运行 `npm run test:verbose`。薄入口 `test/run.mjs` 只负责把追加的 Node test runner 参数放在测试文件 glob 之前，因此两种入口都支持筛选，例如 `npm test -- --test-name-pattern "status|卸载"`。

若修改了安装或构建，可额外运行：

```bash
npm run build -- --target .test
```

只报告实际运行并观察到的结果。

可选的隔离验收夹具见 [test/acceptance/README.md](test/acceptance/README.md)。
`node --test test/acceptance/*.test.mjs` 只运行夹具回归，不启动 OpenCode 或模型；
真实宿主和模型验收必须单独显式运行。这些资产不进入 npm 发布包或默认 `npm test`。

## 提交与 Pull Request

- 未收到明确授权时不要提交或推送。
- 一个提交或 Pull Request 聚焦一个逻辑目的，不混入无关格式化、依赖升级或重命名。
- 提交信息使用精简的 Conventional Commits 格式，例如 `fix(runtime): retain uncertain write lock`。
- Pull Request 说明修改原因、主要变化、实际验证和残余风险。

## Releases 与历史治理

- commit 正文解释一次逻辑变化，tag 标识一个版本，GitHub Release notes 向用户解释该版本。三者是不同交付物，不能互相替代；只有 tag 不构成一次 Release。
- `v0.1.0-rc.1` 是公开兼容基线；此后的公开工具、CLI、配置和文档变化都对照它评估兼容性。候选版本使用标准 SemVer 格式 `MAJOR.MINOR.PATCH-rc.NUMBER`，Git tag 在同一版本前添加 `v`，并在 GitHub Release 中标记为 prerelease。
- 发布前核对 tag、目标提交、`package.json`、`package-lock.json` 和 `VERSION` 的版本一致；候选版本发布到 npm 时使用 `npm publish --tag rc`，不得占用稳定版 `latest`。npm 包发布前确认 `files` 字段实际打包内容与 npm 页面上可解析的文档链接。
- 每次公开 GitHub Release 必须有实质 notes：首个版本描述可用能力与边界，后续版本描述相对前一版本的变化；只写版本号、提交标题清单或自动生成的比较链接不算 notes。notes 提供中英文等价内容，覆盖发布状态、主要能力或变化、安装或升级方式、兼容与迁移要求、已知限制，以及有证据支撑的验证结论；未运行或未通过的检查如实说明，不得把 CI 未覆盖的平台描述为已验收。
- 只描述被打 tag 的提交上真实存在的内容，不描述未提交或之后的改动；验证链接可访问。
- 公开基线如需重建（全部提交压缩为单个基线提交），先在 Gitee 保留完整历史的镜像仓库，再压缩并强推 GitHub；改写已公开历史、移动既有 tag 或强推都必须获得单独明确授权，不属于文档修复或常规提交的隐含权限。
- 准备并审阅 notes 之后，才获得创建或编辑线上 Release 的明确授权；为既有 tag 补充 notes 不改变其提交，但也不修复原提交正文。
