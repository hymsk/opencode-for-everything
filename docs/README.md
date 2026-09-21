# O4E Documentation

[English](README.md) | [中文](README.cn.md)

[Project README](../README.md) | [Contributing](../CONTRIBUTING.md)

This directory contains the public documentation required to install, use,
configure, extend, and troubleshoot `opencode-for-everything`. Internal
reviews, history, implementation plans, acceptance records, and issue ledgers
are kept outside this public user manual.

## Getting started

- [Quick start](getting-started/quick-start.md): install from source and start OpenCode for the first time
- [Project overview](guide/overview.md): understand the `.o4e/` configuration source, Agents, Skills, and Workflow
- [O4E compared with native OpenCode capabilities](guide/opencode-comparison.md): understand what O4E adds, why, and where its boundaries are
- [Current feature overview](guide/features.md): public plugin behavior and its relationship to native OpenCode capabilities
- [Installation guide](guide/installation.md): project, global, and silent installation
- [Usage guide](guide/usage.md): build, status, backup, restore, and uninstall
- [Task sidebar / Task overview](guide/task-overview.md): read-only Bash and sub-agent snapshots above Todo and their TUI lifecycle
- [Automatic task tracking](reference/automatic-follow.md): persistent stop/resume, failure diagnostics, and host acceptance boundaries

## Configuration and extension

- [Creating and refining Agents](guide/creating-agents.md)
- [Configuration reference](reference/configuration.md)
- [Agent reference](reference/agents.md)
- [Workflow reference](reference/workflows.md)
- [Skill reference](reference/skills.md)
- [CLI reference](reference/cli.md)
- [Generated-files reference](reference/generated-files.md)

The repository's `o4e-workflow-creator` Skill maintains the Workflow creation
method; the complete boundary of the installed configuration directory is
described in [`defaults/.o4e/README.md`](../defaults/.o4e/README.md).
See the [`o4e-workflow-creator` Skill](../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md)
for the full method.

## Troubleshooting

- [Troubleshooting](troubleshooting/README.md)
