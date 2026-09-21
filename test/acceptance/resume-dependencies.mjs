#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { hash, spawnOwnedProcess } from "./common.mjs"

const FORMAT = "o4e-resume-dependencies-v2", MAX_BLOB = 64 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024
const check = (value) => { if (!value) throw new Error("DEPENDENCY_ARTIFACT") }
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const same = (a, b) => object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key])
const version = (value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
const sha512 = (bytes) => createHash("sha512").update(bytes).digest("hex")
const blobPath = (cache, digest) => join(cache, "_cacache/content-v2/sha512", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4))

export function dependencyPackage(versions) {
  check(object(versions) && Object.keys(versions).length === 3 && [versions.host, versions.plugin, versions.sdk].every(version))
  return { dependencies: { "@opencode-ai/plugin": versions.plugin, "@opencode-ai/sdk": versions.sdk } }
}

const npmJSON = (value) => { try { return JSON.parse(value) } catch { throw new Error("DEPENDENCY_ARTIFACT") } }

export async function resolveLatestVersions(command) {
  const host = npmJSON(await command("RESOLVE_HOST", "npm", ["view", "opencode-ai@latest", "version", "--json"]))
  const plugin = npmJSON(await command("RESOLVE_PLUGIN", "npm", ["view", "@opencode-ai/plugin@latest", "version", "dependencies.@opencode-ai/sdk", "--json"]))
  const sdk = npmJSON(await command("RESOLVE_SDK", "npm", ["view", "@opencode-ai/sdk@latest", "version", "--json"]))
  check(version(host) && object(plugin) && Object.keys(plugin).length === 2 && version(plugin.version)
    && version(plugin["dependencies.@opencode-ai/sdk"]) && version(sdk)
    && plugin["dependencies.@opencode-ai/sdk"] === sdk && host === plugin.version)
  return Object.freeze({ host, plugin: plugin.version, sdk })
}

function bytes(path, max = 1024 * 1024) {
  const stat = lstatSync(path)
  check(stat.isFile() && stat.nlink === 1 && stat.size <= max && realpathSync(path) === path)
  return readFileSync(path)
}

export function dependencyLock(packageBytes, lockBytes, versions) {
  const pkg = JSON.parse(packageBytes), lock = JSON.parse(lockBytes)
  const expected = dependencyPackage(versions)
  check(Object.keys(pkg).length === 1 && same(pkg.dependencies, expected.dependencies))
  check(lock.lockfileVersion === 3 && object(lock.packages) && same(lock.packages[""]?.dependencies, pkg.dependencies)
    && !lock.packages[""].devDependencies)
  const entries = Object.entries(lock.packages).filter(([name]) => name !== "")
  check(entries.length >= 3 && entries.length <= 200)
  for (const name of ["plugin", "sdk"]) check(lock.packages[`node_modules/@opencode-ai/${name}`]?.version === versions[name])
  check(typeof lock.packages["node_modules/effect"]?.version === "string")
  return entries.map(([name, value]) => {
    check(/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)*$/.test(name)
      && object(value) && !value.dev && !value.link && !value.inBundle && typeof value.version === "string"
      && (!value.optional || !["node_modules/@opencode-ai/plugin", "node_modules/@opencode-ai/sdk", "node_modules/effect"].includes(name))
      && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity))
    const url = new URL(value.resolved)
    check(url.protocol === "https:" && url.host === "registry.npmjs.org" && !url.username && !url.password && !url.search && !url.hash
      && /^\/(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*\/-\/[a-zA-Z0-9._-]+\.tgz$/.test(url.pathname))
    const digest = Buffer.from(value.integrity.slice(7), "base64")
    check(digest.length === 64 && digest.toString("base64") === value.integrity.slice(7))
    const excluded = (values, current) => Array.isArray(values) && values.length > 0
      && values.every((v) => typeof v === "string" && !v.startsWith("!")) && !values.includes("any") && !values.includes(current)
    return { digest: digest.toString("hex"), skippable: value.optional === true && (excluded(value.os, process.platform) || excluded(value.cpu, process.arch)) }
  })
}

// The artifact contains compressed registry bytes, never an old node_modules tree or host state.
export function sealDependencies(prefix, cache, artifact, npmVersion, versions) {
  check(!existsSync(artifact) && /^\d+\.\d+\.\d+$/.test(npmVersion))
  const pkg = bytes(join(prefix, "package.json")), lock = bytes(join(prefix, "package-lock.json")), entries = dependencyLock(pkg, lock, versions)
  mkdirSync(artifact, { mode: 0o700 }); mkdirSync(join(artifact, "blobs"), { mode: 0o700 })
  const blobs = [], seen = new Set(); let total = 0
  for (const entry of entries) {
    if (seen.has(entry.digest)) continue
    const path = blobPath(cache, entry.digest)
    if (!existsSync(path)) { check(entry.skippable); continue }
    const content = bytes(path, MAX_BLOB)
    check(sha512(content) === entry.digest && (total += content.length) <= MAX_TOTAL)
    writeFileSync(join(artifact, "blobs", entry.digest), content, { flag: "wx", mode: 0o400 })
    seen.add(entry.digest); blobs.push({ digest: entry.digest, bytes: content.length })
  }
  const manifest = { format: FORMAT, versions, platform: process.platform, arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]), npmVersion, packageHash: hash(pkg), lockHash: hash(lock), blobs }
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n")
  for (const [name, content] of [["package.json", pkg], ["package-lock.json", lock], ["manifest.json", manifestBytes]]) {
    writeFileSync(join(artifact, name), content, { flag: "wx", mode: 0o400 })
  }
  return { artifactHash: hash(manifestBytes), lockHash: manifest.lockHash, packages: entries.length, tarballs: blobs.length, tarballBytes: total }
}

export function seedDependencies(artifact, expectedHash, prefix, cache) {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && realpathSync(artifact) === artifact && realpathSync(prefix) === prefix
    && ["package.json", "package-lock.json", "node_modules"].every((name) => !existsSync(join(prefix, name))) && !existsSync(cache))
  const raw = bytes(join(artifact, "manifest.json")), manifest = JSON.parse(raw)
  dependencyPackage(manifest.versions)
  check(hash(raw) === expectedHash && manifest.format === FORMAT
    && manifest.platform === process.platform && manifest.arch === process.arch && manifest.nodeMajor === Number(process.versions.node.split(".")[0])
    && /^\d+\.\d+\.\d+$/.test(manifest.npmVersion) && Array.isArray(manifest.blobs) && manifest.blobs.length <= 200)
  const pkg = bytes(join(artifact, "package.json")), lock = bytes(join(artifact, "package-lock.json"))
  check(hash(pkg) === manifest.packageHash && hash(lock) === manifest.lockHash)
  const entries = dependencyLock(pkg, lock, manifest.versions), seen = new Set(); let total = 0
  for (const blob of manifest.blobs) {
    check(/^[a-f0-9]{128}$/.test(blob.digest) && !seen.has(blob.digest) && entries.some((entry) => entry.digest === blob.digest)
      && Number.isSafeInteger(blob.bytes) && blob.bytes > 0 && blob.bytes <= MAX_BLOB && (total += blob.bytes) <= MAX_TOTAL)
    seen.add(blob.digest)
  }
  check(entries.every((entry) => entry.skippable || seen.has(entry.digest)))
  for (const blob of manifest.blobs) {
    const content = bytes(join(artifact, "blobs", blob.digest), MAX_BLOB)
    check(content.length === blob.bytes && sha512(content) === blob.digest)
    const target = blobPath(cache, blob.digest)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { flag: "wx", mode: 0o600 })
  }
  for (const [name, content] of [["package.json", pkg], ["package-lock.json", lock]]) writeFileSync(join(prefix, name), content, { flag: "wx", mode: 0o600 })
  return { artifactHash: expectedHash, lockHash: manifest.lockHash, npmVersion: manifest.npmVersion, versions: manifest.versions, packages: entries.length,
    tarballs: seen.size, tarballBytes: total, omittedOptionalTarballs: entries.filter((entry) => !seen.has(entry.digest)).length }
}

export const OFFLINE_INSTALL = Object.freeze(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"])

export async function prepareDependencyArtifact(root, prepared) {
  check(/^\/tmp\/opencode\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(root) && !existsSync(root) && realpathSync(dirname(root)) === dirname(root))
  if (prepared) check(typeof prepared.path === "string" && prepared.path.startsWith("/") && resolve(prepared.path) === prepared.path
    && /^[a-f0-9]{64}$/.test(prepared.hash) && !prepared.path.startsWith(root + "/") && prepared.path !== root)
  process.umask(0o077); mkdirSync(root, { mode: 0o700 })
  const started = Date.now(), limit = 180000, ownedProcesses = new Set()
  const report = { scope: "dependency-preparation-only", e2e: false, verdict: "failed", reason: "DEPENDENCY_PREPARE", commands: [] }
  const env = { PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"), HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "cache"), npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_fetch_timeout: "60000", npm_config_fetch_retries: "0",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true" }
  let stopped = false
  const stop = () => { stopped = true; for (const owned of ownedProcesses) owned.stop() }
  process.on("SIGINT", stop); process.on("SIGTERM", stop)
  const deadline = setTimeout(stop, limit)
  const command = async (stage, binary, args, cwd) => {
    const commandAt = Date.now(), timeout = limit - (commandAt - started)
    check(!stopped && timeout > 0)
    const owned = spawnOwnedProcess(binary, args, { cwd, env, timeout, cleanupMs: 3000 }); ownedProcesses.add(owned)
    const record = { stage, elapsedMs: 0, cleaned: false, exitCode: null }; report.commands.push(record)
    let stdout = "", size = 0
    owned.child.stdout.on("data", (chunk) => { size += chunk.length; stdout += chunk.toString(); if (size > 2 * 1024 * 1024) stop() })
    owned.child.stderr.on("data", (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) stop() })
    try {
      const result = await owned.result; record.cleaned = result.cleaned; record.exitCode = result.exitCode
      check(!stopped && result.exitCode === 0)
    } finally { record.elapsedMs = Date.now() - commandAt; owned.stop(); ownedProcesses.delete(owned) }
    return stdout.trim()
  }
  try {
    for (const name of ["home", "tmp", "project", "offline"]) mkdirSync(join(root, name), { mode: 0o700 })
    for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(root, name), "", { flag: "wx", mode: 0o600 })
    const prefix = join(root, "project"), artifact = prepared?.path ?? join(root, "artifact")
    const npmVersion = await command("NPM_VERSION", "npm", ["--version"], prefix)
    check(/^\d+\.\d+\.\d+$/.test(npmVersion))
    if (!prepared) {
      const versions = await resolveLatestVersions((stage, binary, args) => command(stage, binary, args, prefix))
      writeFileSync(join(prefix, "package.json"), JSON.stringify(dependencyPackage(versions)) + "\n", { flag: "wx", mode: 0o600 })
      await command("DOWNLOAD", "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], prefix)
      report.artifact = sealDependencies(prefix, env.npm_config_cache, artifact, npmVersion, versions)
    }
    const proof = seedDependencies(artifact, prepared?.hash ?? report.artifact.artifactHash, join(root, "offline"), join(root, "offline-cache"))
    check(proof.npmVersion === npmVersion)
    report.artifact = proof
    await command("OFFLINE_INSTALL", "npm", [...OFFLINE_INSTALL, "--cache", join(root, "offline-cache")], join(root, "offline"))
    await command("OFFLINE_IMPORTS", process.execPath, ["--input-type=module", "-e",
      'for(const name of ["@opencode-ai/plugin", "@opencode-ai/plugin/tool", "@opencode-ai/sdk", "effect"]) await import(name)'], join(root, "offline"))
    check(hash(bytes(join(root, "offline/package-lock.json"))) === proof.lockHash && Date.now() - started < limit)
    report.verdict = "prepared"; report.reason = "NONE"; report.offlineInstallVerified = true
  } catch { report.reason = stopped ? "DEPENDENCY_PREPARE_BUDGET_OR_SIGNAL" : "DEPENDENCY_PREPARE" }
  finally {
    stop(); await Promise.allSettled([...ownedProcesses].map((owned) => owned.result)); clearTimeout(deadline)
    process.off("SIGINT", stop); process.off("SIGTERM", stop)
    report.ownedProcessesStopped = report.commands.every((entry) => entry.cleaned)
    if (!report.ownedProcessesStopped) { report.verdict = "failed"; report.reason = "CLEANUP" }
    report.elapsedMs = Date.now() - started
    writeFileSync(join(root, "prepare-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const verify = process.argv[2] === "--verify"
    check(verify ? process.argv.length === 8 && process.argv[4] === "--sha256" && process.argv[6] === "--root"
      : process.argv.length === 4 && process.argv[2] === "--prepare")
    const report = await prepareDependencyArtifact(verify ? process.argv[7] : process.argv[3], verify ? { path: process.argv[3], hash: process.argv[5] } : undefined)
    process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.verdict === "prepared" ? 0 : 1
  } catch { process.stdout.write('{"verdict":"failed","reason":"DEPENDENCY_ARGUMENTS"}\n'); process.exitCode = 2 }
}
