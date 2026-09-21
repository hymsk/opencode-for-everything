# Prompts 目录

仓库默认模板在本目录维护中英文两套 Agent prompt。安装目标不会复制 `cn/` 或 `en/` 目录，而是把用户选择的一套内容直接放到 `.o4e/prompts/`：

- `cn/` — 中文 prompt
- `en/` — 英文 prompt

## 维护规则

**中英文 prompt 必须保持同步。** 修改任一语言的 prompt 时，必须同步更新另一语言版本，确保：

- 结构一致（目录层级、文件名、inject 文件数量）
- 语义等价（表达相同含义，而非逐字翻译）
- 新增或删除文件时，两个语言目录同步操作

## 目录结构

```
prompts/
├── AGENTS.md          # 本文件
├── cn/                # 中文
│   ├── primary/       # 主 agent prompt
│   ├── subagent/      # 子 agent prompt
│   └── system/        # 系统内部阶段 prompt
└── en/                # 英文
    ├── primary/
    ├── subagent/
    └── system/
```

## 安装与配置引用

安装器把所选语言写入 `config.jsonc` 的 `language`，并将 `promptsDir` 设为 `prompts`。build/plan 原生 prompt 也同步到该扁平目录。
