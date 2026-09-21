# Skill Reference

[English](skills.md) | [中文](skills.cn.md)

[← Documentation Home](../README.md) | [Agent Reference](./agents.md) | [Workflow Reference](./workflows.md) | [Creating and Improving Agents](../guide/creating-agents.md)

A Skill is a reusable single-Agent method, loaded on demand, that does not expand Agent permissions. The Skill source of truth and runtime source are both `.o4e/skills/`. The plugin's `config` hook puts the current configuration root's `.o4e/skills/` first in the explicit `skills.paths`, while keeping the host's existing paths and URLs. O4E does not create, overwrite, prune, or uninstall the public `.opencode/skills/` or the global public `skills/`.

## Differences from Agents and Workflows

| Concept | Purpose | Permissions | Persistence |
| --- | --- | --- | --- |
| Agent | defines permission and session boundaries | independent permission domain | Session |
| Skill | reusable single-Agent method | inherits caller permissions | not persisted |
| Workflow | resumable checkpoint flow for the main Agent | adds no permissions; explicit Tasks are authorized independently | owner Session metadata |

## Managed Skills

O4E's internal managed Skill registry lists the default Skills maintained by the installer and validated by the Builder; it is not part of user `config.jsonc`. By default it includes:

| Skill | Purpose | Usage Guide |
| --- | --- | --- |
| `o4e-agent-creator` | create and improve Agents | [Creating and Improving Agents](../guide/creating-agents.md) |
| `o4e-workflow-creator` | create and improve Workflows | [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md) |

`build` and `status` use the same managed Skill validation: a missing directory means not installed; an existing directory with a missing `SKILL.md`, or a mismatched marker or frontmatter name, errors directly. `status` only checks the default Skills in the registry and does not scan user-built Skills. Builds and installs still validate the configuration tree before writing, rejecting symlinks, hard links, and special files.

## Skill Lifecycle

1. **Install**: the installer writes the selected default Skills to `.o4e/skills/` per `--skill=<name>` or `--no-skills`
2. **Define**: maintain Skill content in `.o4e/skills/<skill-name>/SKILL.md`
3. **Validate**: run `node scripts/installer.mjs build --target /path/to/project` to validate the directory, marker, frontmatter, and file types of the selected managed Skills
4. **Register**: the plugin puts the current configuration root's `.o4e/skills/` before the existing explicit `skills.paths`
5. **Load**: when an Agent invokes a Skill it is loaded on demand, not automatically injected into the system prompt
6. **Execute**: Skill content is loaded temporarily and released after execution

Silent installs select all default Skills by default. Repeat `--skill=<name>` for precise selection, or use `--no-skills` to install an empty set. Each installation first deletes the same-named directory of every default Skill in the internal registry: selected ones are rewritten in full, unselected ones stay deleted. User Skill directories outside the registry are preserved.

## Skill Directory Structure

```text
.o4e/skills/<skill-name>/
├── SKILL.md              # Skill 主文件（必需）
├── agents/               # 可选：Skill 专用 Agent 配置
├── references/           # 可选：参考文档
├── templates/            # 可选：模板文件
└── evals/                # 可选：评测集
    └── evals.json
```

## Configuring the Skill Tool

In Agent configuration, `loadSkills` is a Skill name allowlist:

```jsonc
{
  "loadSkills": ["*"]  // 默认值；不按名称限制
}
```

Reject all Skills:

```jsonc
{
  "loadSkills": []
}
```

Allow only the specified Skills:

```jsonc
{
  "loadSkills": ["o4e-agent-creator", "o4e-workflow-creator"]
}
```

A concrete name array is projected as `skill: { "*": "deny", <name>: "allow" }`.
`config.loadSkills` is only the default when an Agent omits the field; an Agent's explicit array completely overrides
config, a Plan inherits the Agent when omitted, and a Plan's explicit array completely overrides the Agent. `["*"]` cannot be mixed with
other names, and duplicate names and legacy boolean values are rejected. A later explicit `permission` can still intentionally
override the base projection.

## Managed Markers

The installer recognizes the default Skill names it maintains through the internal registry, and validates written content through markers. Names in the registry belong to O4E default Skills: same-named directories are completely overwritten or deleted at install time. The Builder only validates registry default Skills currently present; user Skills with other names are still discovered by the plugin through the same `.o4e/skills/` source.

Markers ship with O4E default Skill assets and are used by the installer to identify managed content. The definition, format, and creation of generic Skills are OpenCode host capabilities, are not separately defined by O4E, and do not require adding an O4E marker.

## Best Practices

1. **Single responsibility**: each Skill does one thing
2. **Reusable**: a Skill should be shareable across multiple Agents
3. **No permission expansion**: a Skill inherits caller permissions and does not define its own
4. **Complete documentation**: SKILL.md should include usage and examples
5. **Evaluation coverage**: write evaluation sets for critical Skills

## See Also

- [Agent Reference](./agents.md): Agent configuration and permissions
- [Workflow Reference](./workflows.md): the main Agent process-v1 checkpoint flow
- [Creating and Improving Agents](../guide/creating-agents.md): using the o4e-agent-creator Skill
- [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md): creating and improving Workflows
- [Generated Files Reference](./generated-files.md): the boundary between configuration source and runtime artifacts
