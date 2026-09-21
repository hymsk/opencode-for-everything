import { lstat, realpath, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { compilePermissionRules, evaluateResources } from "../../core/permission-rules.mjs"
import { resolveShellProfile } from "./shell-profile.mjs"

const require = createRequire(import.meta.url)
const ACTIONS = new Set(["allow", "ask", "deny"])
// POSIX entries from OpenCode src/tool/shell.ts; no host-private imports.
const CWD = new Set(["cd", "chdir", "popd", "pushd"])
const FILES = new Set([...CWD, "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"])
let languagePromise

function fail(code, message) {
  throw Object.assign(new Error(message), { code: `O4E_BASH_${code}` })
}

async function language() {
  return languagePromise ??= (async () => {
    const { Parser, Language } = await import("web-tree-sitter")
    await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") })
    return { Parser, bash: await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")) }
  })()
}

// Decode only parser-proven literal tokens, never evaluate shell/environment text.
function literal(node) {
  if (!node || node.hasError) return null
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "string" || node.type === "concatenation") {
    const parts = node.namedChildren.map(literal)
    return parts.includes(null) ? null : parts.join("")
  }
  if (!["word", "number", "string_content"].includes(node.type)) return null
  const quoted = node.type === "string_content"
  let value = ""
  for (let index = 0; index < node.text.length; index += 1) {
    const char = node.text[index]
    if (char === "\\") {
      const next = node.text[++index]
      if (next === undefined) return null
      if (next === "\n") continue
      if (quoted && !['$', '`', '"', '\\'].includes(next)) value += "\\"
      value += next
    } else {
      if (!quoted && "*?[]{}~".includes(char)) return null
      value += char
    }
  }
  return value
}

function redirectParts(node, command) {
  const token = node.children.find((child) => !child.isNamed)
  const operator = token?.text
  const destinations = node.childrenForFieldName("destination")
  // Compound here-strings may recover with ERROR nodes before or after the
  // apparent < token. Read the entire operator before its first destination,
  // removing only Bash line continuations; <<< supplies text, not a file.
  if (operator === "<") {
    const previous = node.previousNamedSibling
    const start = node.childForFieldName("descriptor")?.endIndex
      ?? (previous?.type === "ERROR" ? previous.startIndex : token.startIndex)
    const source = command.slice(start, destinations[0]?.startIndex ?? token.endIndex)
    if (source.replaceAll("\\\n", "").trim() === "<<<") return { operator: "<<<", destination: [], arguments: [] }
  }
  // The grammar includes following command arguments in destination. A fd
  // closure has no target; an ordinary redirect consumes just the first word,
  // including fragments split at escaped newlines.
  let end = [">&-", "<&-"].includes(operator) ? 0 : Math.min(1, destinations.length)
  while (end && end < destinations.length && /^(?:\\\n)+$/.test(command.slice(destinations[end - 1].endIndex, destinations[end].startIndex))) end += 1
  return { operator, destination: destinations.slice(0, end), arguments: destinations.slice(end) }
}

async function resourcePath(value, cwd) {
  let resolved = path.isAbsolute(value) ? "/" : cwd
  // Resolve before processing '..', including links above a not-yet-created file.
  for (const part of value.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      resolved = path.dirname(resolved)
      continue
    }
    const next = path.join(resolved, part)
    try {
      resolved = await realpath(next)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      const entry = await lstat(next).catch((error) => {
        if (error.code !== "ENOENT") throw error
        return null
      })
      if (entry?.isSymbolicLink()) return
      resolved = next
    }
  }
  return resolved
}

/**
 * Authorize only; never execute, expand the environment, or resolve Agent identity.
 * The parser only extracts permission resources; Bash interprets the unchanged
 * command, including expansions, control flow, functions and indirect execution.
 * Raw atomic resources and their decodable literal tokens both require host
 * authorization. Dynamic tokens remain source text, never evaluated here.
 * Unparsed/no-command input still requires authorization for its entire source.
 * External-directory checks cover statically known operands and redirects, not
 * dynamically resolved paths or effects hidden in scripts. This is not a sandbox.
 * `permission` is an optional canonical O4E config permission value, used only to
 * tighten denies. Host context.ask is mandatory even for explicit allow.
 */
export async function authorizeBash(args, context, { directory, worktree, shell, permission } = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("INVALID_ARGUMENTS", "Bash args must be an object")
  // Strict provider adapters may encode an optional property as
  // required-but-nullable. Null is the transport equivalent of omission;
  // every other invalid value remains fail-closed below.
  const { command, description } = args
  const workdir = args.workdir === null ? undefined : args.workdir
  const timeout = args.timeout === undefined || args.timeout === null ? 120000 : args.timeout
  if (typeof command !== "string" || !command.trim() || command.includes("\0") || Buffer.byteLength(command, "utf8") > 65536) {
    fail("INVALID_ARGUMENTS", "Bash command must be nonempty, NUL-free, and at most 64 KiB")
  }
  if (typeof description !== "string" || !description.trim()) fail("INVALID_ARGUMENTS", "Bash description must be nonempty")
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
    fail("INVALID_ARGUMENTS", "Bash timeout must be a safe integer in 1..2147483647")
  }
  if (workdir !== undefined && (typeof workdir !== "string" || !workdir.trim() || workdir.includes("\0"))) {
    fail("INVALID_ARGUMENTS", "Bash workdir must be a nonempty, NUL-free path")
  }
  try { resolveShellProfile(shell) } catch { fail("UNSUPPORTED_SHELL", "OpenCode host shell could not be resolved") }
  if (typeof context?.ask !== "function") fail("ASK_REQUIRED", "Bash authorization requires host context.ask")
  const contextDirectory = context.directory ?? directory
  for (const [key, value] of Object.entries({ directory: directory ?? contextDirectory, contextDirectory, worktree })) {
    if (value === undefined && key === "worktree") continue
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
      fail("INVALID_ARGUMENTS", `Bash ${key} must be an absolute, NUL-free path`)
    }
  }
  if (permission !== undefined && !ACTIONS.has(permission)) {
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) fail("INVALID_ARGUMENTS", "Invalid Bash permission config")
    for (const rule of Object.values(permission)) {
      if (ACTIONS.has(rule)) continue
      if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.values(rule).some((action) => !ACTIONS.has(action))) {
        fail("INVALID_ARGUMENTS", "Invalid Bash permission config")
      }
    }
  }
  const rules = compilePermissionRules(permission)
  const root = await realpath(directory ?? contextDirectory)
  const base = await realpath(contextDirectory)
  const cwd = await realpath(workdir === undefined ? base : path.isAbsolute(workdir) ? workdir : `${base}/${workdir}`)
  if (!(await stat(cwd)).isDirectory()) fail("INVALID_ARGUMENTS", "Bash workdir must resolve to a directory")
  const roots = [root]
  if (worktree !== undefined && worktree !== "/") {
    const canonical = await realpath(worktree)
    if (canonical !== "/") roots.push(canonical)
  }
  const contains = (value) => roots.some((root) => {
    const relative = path.relative(root, value)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  })
  const directories = new Set()
  const patterns = new Set()
  const addPath = async (value) => {
    if (!value) return
    try {
      const resolved = await resourcePath(value, cwd)
      if (!resolved || contains(resolved)) return
      const info = await stat(resolved).catch((error) => {
        if (error.code !== "ENOENT") throw error
        return null
      })
      directories.add(info?.isDirectory() ? resolved : path.dirname(resolved))
    } catch { /* Unknown operands remain subject to Bash authorization and errors. */ }
  }
  const { Parser, bash } = await language()
  const parser = new Parser()
  let tree
  try {
    parser.setLanguage(bash)
    try { tree = parser.parse(command) } catch { /* Bash owns syntax validation. */ }
    if (!tree || tree.rootNode.hasError) patterns.add(command.trim())
    const commands = tree?.rootNode.descendantsOfType("command") ?? []
    for (const node of commands) {
      // Match host source(node), preserving atomic commands inside larger scripts.
      patterns.add((node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim())
      const name = node.childForFieldName("name")
      if (name?.namedChildCount !== 1) continue
      // Trailing list/pipeline/negation redirects belong to their last command;
      // do not cross a subshell or compound-command boundary.
      let statement = node
      while (["list", "pipeline", "negated_command"].includes(statement.parent?.type)
        && statement.parent.lastNamedChild?.id === statement.id) statement = statement.parent
      const redirects = [...node.childrenForFieldName("redirect"),
        ...(statement.parent?.type === "redirected_statement" ? statement.parent.childrenForFieldName("redirect") : [])]
      const nodes = [name.firstNamedChild, ...node.childrenForFieldName("argument"),
        ...redirects.flatMap((redirect) => redirect.type === "file_redirect"
          ? redirectParts(redirect, command).arguments : redirect.childrenForFieldName("argument")),
      ].sort((left, right) => left.startIndex - right.startIndex)
      const tokens = []
      for (const [index, token] of nodes.entries()) {
        const value = literal(token)
        // The grammar splits words at escaped newlines. Join only a proven
        // continuation-only gap, never whitespace or redirects between tokens.
        const gap = index ? command.slice(nodes[index - 1].endIndex, token.startIndex) : ""
        if (index && /^(?:\\\n)+$/.test(gap)) {
          const previous = tokens.at(-1)
          previous.value = previous.value === null || value === null ? null : previous.value + value
          previous.source += gap + token.text
        } else tokens.push({ value, source: token.text })
      }
      const [cmd, ...arguments_] = tokens.map((token) => token.value)
      patterns.add(tokens.map(({ value, source }) => value === null ? source
        : /^[A-Za-z0-9_./:@=,+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`).join(" "))
      if (FILES.has(cmd)) {
        let options = true
        for (const value of arguments_) {
          if (value === "--" && options) { options = false; continue }
          if (options && value?.startsWith("-")) {
            continue
          }
          if (cmd === "chmod" && value?.startsWith("+")) continue
          await addPath(value)
        }
      }
    }
    for (const node of tree?.rootNode.descendantsOfType("file_redirect") ?? []) {
      // Include group/redirect-only resources even for fd moves and closures.
      if (node.parent.type === "redirected_statement" && node.parent.childForFieldName("body")?.type !== "command") {
        patterns.add(node.parent.text.trim())
      }
      const { operator, destination } = redirectParts(node, command)
      if ([">&-", "<&-"].includes(operator)) continue
      const fragments = destination.map(literal)
      const value = fragments.includes(null) ? null : fragments.join("")
      if ([">&", "<&"].includes(operator) && value !== null && /^(?:[0-9]+-?|-)$/.test(value)) continue
      await addPath(value)
    }
    if (patterns.size === 0) patterns.add(command.trim())
  } finally {
    tree?.delete()
    parser.delete()
  }
  if (!contains(cwd)) directories.add(cwd)
  const globs = [...directories].map((dir) => path.join(dir, "*"))
  for (const [name, resources] of [["external_directory", globs], ["bash", [...patterns]]]) {
    if (evaluateResources(name, resources, rules) === "deny") fail("PERMISSION_DENIED", `Configured ${name} permission denied`)
  }
  if (globs.length) {
    await context.ask({
      permission: "external_directory", patterns: globs, always: globs,
      metadata: { command, directories: [...directories], patterns: globs },
    })
  }
  await context.ask({
    permission: "bash", patterns: [...patterns],
    // Do not turn one approval into a remembered grant for other commands.
    always: [], metadata: { command },
  })
  return { command, cwd, timeout, description, shell, patterns: [...patterns], directories: [...directories] }
}
