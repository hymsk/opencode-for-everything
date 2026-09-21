import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix, resolve } from "node:path"

const docsRoot = resolve(import.meta.dirname, "../docs")

function markdownFiles(directory = docsRoot, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) markdownFiles(path, files)
    else if (entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

test("公开文档保持英文主文档与中文镜像成对", () => {
  for (const path of markdownFiles()) {
    const mirror = path.endsWith(".cn.md") ? path.replace(/\.cn\.md$/, ".md") : path.replace(/\.md$/, ".cn.md")
    assert.equal(existsSync(mirror) && statSync(mirror).isFile(), true, `${path} must have a bilingual mirror file`)
  }
})

function codeBlocks(content) {
  const blocks = []
  let current = null
  for (const line of content.split("\n")) {
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const marker = fence[1]
      if (current && current.marker[0] === marker[0] && marker.length >= current.marker.length) {
        blocks.push(current)
        current = null
      } else if (!current) {
        current = {
          marker,
          language: fence[2].trim().split(/\s+/, 1)[0],
          lines: [],
        }
      }
      continue
    }
    if (current) current.lines.push(line)
  }
  assert.equal(current, null, "Markdown code fences must be balanced")
  return blocks
}

function headings(content) {
  return [...content.matchAll(/^(#{1,6})\s+(.+?)\s*#?$/gm)].map((match) => match[1].length)
}

function normalizeLocalTarget(target) {
  const [path, anchor = ""] = target.split("#", 2)
  return `${posix.normalize(path.replaceAll(".cn.md", ".md"))}#${anchor}`
}

function rawLocalLinks(content) {
  return [...content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .filter((target) => !target.endsWith("#"))
}

function localLinks(content) {
  return rawLocalLinks(content)
    .map(normalizeLocalTarget)
    .sort()
}

function githubAnchor(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\\`*_~]/g, "")
    .replace(/[^\w\u4e00-\u9fff -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function assertLocalLinksResolve(sourcePath, content) {
  for (const target of rawLocalLinks(content)) {
    const [rawPath, anchor = ""] = target.split("#", 2)
    const targetPath = resolve(dirname(sourcePath), decodeURIComponent(rawPath))
    assert.equal(existsSync(targetPath), true, `${sourcePath} links to missing local path ${rawPath}`)
    if (anchor) {
      assert.equal(statSync(targetPath).isFile(), true, `${sourcePath} links to an anchor on a non-file path ${target}`)
      const targetContent = readFileSync(targetPath, "utf8")
      const anchors = new Set([...targetContent.matchAll(/^#{1,6}\s+(.+?)\s*#?$/gm)].map((match) => githubAnchor(match[1])))
      assert.equal(anchors.has(decodeURIComponent(anchor)), true,
        `${sourcePath} links to missing anchor ${target}`)
    }
  }
}

function codeStructure(block) {
  if (!["bash", "sh", "shell", "json", "jsonc", "yaml", "yml"].includes(block.language)) return []
  const source = block.lines
    .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
    .map((line) => line.replace(/[\u4e00-\u9fff]+/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
  if (["json", "jsonc", "yaml", "yml"].includes(block.language)) {
    return source.flatMap((line) => [
      ...(line.match(/(?:^|\s)["']?([A-Za-z_$][\w$.-]*)["']?\s*:/g) ?? []).map((key) => key.replace(/^[\s"']+|["':\s]+$/g, "")),
      ...(line.match(/--[A-Za-z][\w-]*/g) ?? []),
    ])
  }
  return source
}

test("英文与中文公开文档保持章节、代码块和链接结构一致", () => {
  for (const path of markdownFiles()) {
    if (!path.endsWith(".cn.md")) continue
    const englishPath = path.replace(/\.cn\.md$/, ".md")
    const english = readFileSync(englishPath, "utf8")
    const chinese = readFileSync(path, "utf8")
    assert.deepEqual(
      headings(english),
      headings(chinese),
      `${path} must keep the same heading hierarchy and order as its English mirror`,
    )
    const englishBlocks = codeBlocks(english)
    const chineseBlocks = codeBlocks(chinese)
    assert.deepEqual(englishBlocks.map((block) => block.language), chineseBlocks.map((block) => block.language),
      `${path} must keep code-block languages and order`)
    assert.deepEqual(englishBlocks.map(codeStructure), chineseBlocks.map(codeStructure),
      `${path} must keep operational commands and configuration keys in code blocks`)
    assertLocalLinksResolve(englishPath, english)
    assertLocalLinksResolve(path, chinese)
    assert.deepEqual(
      localLinks(english).map((target) => target.replace(/#.*$/, "#")),
      localLinks(chinese).map((target) => target.replace(/#.*$/, "#")),
      `${path} must keep normalized local link paths`,
    )
  }
})

test("包版本元数据使用一致的标准 SemVer 候选版本格式", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"))
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim()
  assert.match(manifest.version, /^\d+\.\d+\.\d+-rc\.\d+$/)
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages?.[""]?.version, manifest.version)
  assert.equal(version, manifest.version)
})
