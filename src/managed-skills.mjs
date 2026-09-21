import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"

// O4E 默认受管 Skill registry。它是安装器和 Builder 的内部契约，不属于用户配置。
const DEFAULT_MANAGED_SKILL_NAMES = [
  "o4e-agent-creator",
  "o4e-workflow-creator",
]

export function readManagedSkills(configRoot, { required = false } = {}) {
  const skillsRoot = join(configRoot, "skills")
  const rootStat = lstatSync(skillsRoot, { throwIfNoEntry: false })
  if (!rootStat && !required) return []
  if (!rootStat?.isDirectory()) throw new Error(`配置 Skill 目录必须是普通目录: ${skillsRoot}`)

  const skills = []
  for (const name of DEFAULT_MANAGED_SKILL_NAMES) {
    const directory = join(skillsRoot, name)
    const directoryStat = lstatSync(directory, { throwIfNoEntry: false })
    if (!directoryStat && !required) continue
    if (!directoryStat?.isDirectory()) throw new Error(`Skill 目录必须是普通目录: ${directory}`)
    const source = join(directory, "SKILL.md")
    const stat = lstatSync(source, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.nlink !== 1) throw new Error(`Skill 必须是独立普通文件: ${source}`)
    const content = readFileSync(source, "utf8")
    if (!content.includes(`<!--opencode-for-everything-skill:${name}-->`)) throw new Error(`受管 Skill 缺少匹配名称 marker: ${source}`)
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    if (frontmatter?.match(/^name:\s*([^\s#]+)\s*$/m)?.[1] !== name) throw new Error(`Skill frontmatter name 必须与目录名一致: ${source}`)
    skills.push({ name, directory })
  }
  return skills
}
