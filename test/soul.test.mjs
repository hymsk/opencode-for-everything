import assert from "node:assert/strict"
import { linkSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createSoulHandler, resolveSoulContent } from "../src/soul.mjs"
import { createDirectoryLink, createFileLink } from "./helpers/fs-link-fixture.mjs"

test("extend 合并不同 soul，但同一路径只读取一次", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-soul-"))
  try {
    const projectSoulPath = join(target, "soul.md")
    const globalSoulPath = join(target, "global-soul.md")
    writeFileSync(projectSoulPath, "project soul")
    writeFileSync(globalSoulPath, "global soul")

    const result1 = resolveSoulContent(target, {
      enabled: true,
      file: "soul.md",
      globalFile: globalSoulPath,
      inheritMode: "extend",
    })
    assert.equal(result1.content, "global soul\n\n---\n\nproject soul")
    assert.equal(result1.scope, "project")

    const result2 = resolveSoulContent(target, {
      enabled: true,
      file: "soul.md",
      globalFile: projectSoulPath,
      inheritMode: "extend",
    })
    assert.equal(result2.content, "project soul")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("system 注入以最终 prompt 为准且重复执行保持单份", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-soul-"))
  try {
    writeFileSync(join(target, "soul.md"), "configured soul")
    const handler = createSoulHandler(target, { soul: { enabled: true, file: "soul.md", inheritMode: "override" } })
    const output = { system: ["managed prompt"] }

    handler.transformSystem(output)
    handler.transformSystem(output)

    assert.match(output.system[0], /^<!--opencode-for-everything-soul:start-->\n<!-- SOUL_FILE:.*\(scope: project\) -->\nconfigured soul/)
    assert.equal(output.system[0].match(/configured soul/g)?.length, 1)
    assert.match(output.system[0], /<!--opencode-for-everything-soul:end-->\n\nmanaged prompt$/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("soul 不再可用时清理已有注入块", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-soul-"))
  try {
    const soulPath = join(target, "soul.md")
    writeFileSync(soulPath, "configured soul")
    const output = { system: ["managed prompt"] }

    const handler = createSoulHandler(target, {
      soul: { enabled: true, file: "soul.md", inheritMode: "override", globalFile: join(target, "missing-global-soul.md") },
    })
    handler.transformSystem(output)
    rmSync(soulPath)
    handler.transformSystem(output)

    assert.deepEqual(output.system, ["managed prompt"])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("同一个 handler 在每次使用时读取最新 soul", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-soul-"))
  try {
    const soulPath = join(target, "soul.md")
    writeFileSync(soulPath, "initial soul")
    const handler = createSoulHandler(target, {
      soul: { enabled: true, file: "soul.md", inheritMode: "override", globalFile: join(target, "missing-global-soul.md") },
    })
    const output = { system: ["managed prompt"] }

    handler.transformSystem(output)
    assert.match(output.system[0], /initial soul/)

    writeFileSync(soulPath, "updated soul")
    const nextMtime = new Date(Date.now() + 2000)
    utimesSync(soulPath, nextMtime, nextMtime)
    handler.transformSystem(output)
    assert.match(output.system[0], /updated soul/)
    assert.doesNotMatch(output.system[0], /initial soul/)

    rmSync(soulPath)
    handler.transformSystem(output)
    assert.deepEqual(output.system, ["managed prompt"])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("项目 soul 拒绝符号链接和硬链接", () => {
  for (const linkType of ["symbolic", "hard"]) {
    const target = mkdtempSync(join(tmpdir(), `o4e-soul-linked-${linkType}-`))
    try {
      const externalSoul = join(target, "external-soul.md")
      const projectSoul = join(target, "soul.md")
      writeFileSync(externalSoul, "external soul")
      if (linkType === "symbolic") createFileLink(externalSoul, projectSoul)
      else linkSync(externalSoul, projectSoul)

      assert.equal(resolveSoulContent(target, {
        enabled: true,
        file: "soul.md",
        globalFile: join(target, "missing-global-soul.md"),
        inheritMode: "override",
      }), null)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

test("soul 拒绝符号链接父目录", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-soul-linked-parent-"))
  const external = mkdtempSync(join(tmpdir(), "o4e-soul-linked-parent-external-"))
  try {
    mkdirSync(join(target, "nested"))
    writeFileSync(join(external, "soul.md"), "external soul")
    rmSync(join(target, "nested"), { recursive: true })
    createDirectoryLink(external, join(target, "nested"))
    assert.equal(resolveSoulContent(target, { enabled: true, file: "nested/soul.md", inheritMode: "override" }), null)
    assert.equal(resolveSoulContent(target, { enabled: true, file: "soul.md", globalFile: join(target, "nested", "soul.md"), inheritMode: "override" }), null)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})
