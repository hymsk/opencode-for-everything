import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { authorizeBash } from "../src/adapters/opencode/bash-permission.mjs"
import { buildRuntime } from "../src/runtime-builder.mjs"
import { compilePermissionRules, evaluate } from "../src/core/permission-rules.mjs"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const parserDependencies = { "tree-sitter-bash": "0.25.0", "web-tree-sitter": "0.25.10" }

function fixture(t, permission = { "*": "allow" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "o4e-bash-permission-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, "project")
  const external = join(root, "outside")
  mkdirSync(directory)
  mkdirSync(external)
  const calls = []
  const prompts = []
  const rules = compilePermissionRules(permission)
  const context = {
    directory,
    async ask(input) {
      assert.equal(this, context)
      calls.push(structuredClone(input))
      // Host evaluates every pattern before prompting, with last-match rules.
      const decisions = input.patterns.map((pattern) => evaluate(input.permission, pattern, rules).action)
      if (decisions.includes("deny")) throw new Error(`host denied ${input.permission}`)
      if (decisions.includes("ask")) prompts.push(input)
    },
  }
  const options = { directory, worktree: "/", shell: "/bin/bash" }
  return {
    root, directory, external, context, options, calls, prompts,
    authorize(command, args = {}, overrides = {}) {
      return authorizeBash({ command, description: "Permission test", ...args }, context, { ...options, ...overrides })
    },
  }
}

test("Bash validation and host allow return the exact execution contract without environment", async (t) => {
  const f = fixture(t)
  const command = "  git status  "
  const result = await f.authorize(command, { env: { IGNORED: "value" } }, { permission: "allow" })
  assert.deepEqual(result, {
    command, description: "Permission test", cwd: f.directory, shell: "/bin/bash",
    timeout: 120000, patterns: ["git status"], directories: [],
  })
  assert.deepEqual(f.calls, [{ permission: "bash", patterns: ["git status"], always: [], metadata: { command } }])
  assert.equal(f.prompts.length, 0)
  assert.equal((await f.authorize("true", { timeout: 1 })).timeout, 1)
  assert.equal((await f.authorize("true", { timeout: 2147483647 })).timeout, 2147483647)
  const nullable = await f.authorize("true", { workdir: null, timeout: null })
  assert.equal(nullable.cwd, f.directory)
  assert.equal(nullable.timeout, 120000)
})

test("Bash preserves atomic commands in lists, pipelines, and groups", async (t) => {
  const f = fixture(t)
  for (const [command, patterns] of [
    ["git status && rm local", ["git status", "rm local"]],
    ["git status || rm local; echo done", ["git status", "rm local", "echo done"]],
    ["git status\nrm local", ["git status", "rm local"]],
    ["git status | rm local", ["git status", "rm local"]],
    ["(git status; rm local)", ["git status", "rm local"]],
    ["{ git status; rm local; }", ["git status", "rm local"]],
    ["! git status", ["git status"]],
    ["git status && git status", ["git status"]],
  ]) {
    assert.deepEqual((await f.authorize(command)).patterns, patterns, command)
    assert.deepEqual(f.calls.at(-1).patterns, patterns, command)
    assert.deepEqual(f.calls.at(-1).always, [])
  }
})

test("Bash raw and canonical resources both enforce host deny and ask", async (t) => {
  const f = fixture(t, { bash: { "*": "allow", "rm *": "deny" } })
  for (const command of [
    "git status && rm local", "git status | rm local", "true && rm\tlocal",
    "true | rm\tlocal > local", "2>&1 rm local", "rm > output local", "rm 2>&- local",
    "true | rm > output local", "true && rm > output local", "! rm > output local",
    "'rm' local", "r\\m local", "r\\\nm local",
  ]) {
    await assert.rejects(f.authorize(command), /host denied bash/)
    assert.ok(f.calls.at(-1).patterns.includes("rm local"))
  }
  assert.equal(f.prompts.length, 0)
  const redirected = fixture(t, { bash: { "*": "allow", "false *": "deny" } })
  await assert.rejects(redirected.authorize("2>&1 false"), /host denied bash/)
  assert.deepEqual(redirected.calls[0].patterns, ["2>&1 false", "false"])
  const prompted = fixture(t, { bash: { "*": "allow", "git push*": "ask" } })
  for (const command of ["git\tpush", "git  push", 'git "push"', "git p\\ush", "git pu\\\nsh", 'gi"t" push']) {
    const result = await prompted.authorize(command)
    assert.deepEqual(result.patterns, [command, "git push"], command)
    assert.deepEqual(prompted.prompts.at(-1).patterns, result.patterns)
    assert.deepEqual(prompted.calls.at(-1).always, [])
    assert.equal(result.command, command)
  }
  const rawDenied = fixture(t, { bash: { "*": "allow", 'git "push"': "deny", "git push": "allow" } })
  await assert.rejects(rawDenied.authorize('git "push"'), /host denied bash/)
  assert.deepEqual(rawDenied.calls[0].patterns, ['git "push"', "git push"])
})

test("Bash preserves literal whitespace, Unicode and wildcard characters without executing them", async (t) => {
  const f = fixture(t)
  for (const command of [
    "echo 'a\tb'", "echo 'a\nb'", "echo 'a\rb'", "echo '\u0001'", "echo '\u00a0'", "echo '\u00e9'",
    "echo '*'", "echo '?'", "echo 'a\\b'", "printf '%s\\n' value",
  ]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.ok(result.patterns.includes(command))
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  }
  const command = `cat '${f.external}/$HOME $(rm local) *.txt'`
  const result = await f.authorize(command)
  assert.equal(result.command, command)
  assert.deepEqual(result.directories, [f.external])
  assert.equal(existsSync(join(f.directory, "local")), false)
})

test("Bash authorizes dynamic source without guessing expanded arguments or paths", async (t) => {
  const f = fixture(t, { bash: { "*": "allow", "git push*": "deny" } })
  for (const command of [
    "git $ACTION", 'git "$ACTION"', "echo *.js", "echo ~/file", "echo {a,b}", "echo prefix$VALUE",
    "echo $(rm local)", 'echo "$(rm local)"', "echo `rm local`", "echo <(rm local)", "echo $(echo $(rm local))",
    "printf x | git $ACTION", "echo ok > $FILE",
  ]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.deepEqual(result.directories, [])
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
    assert.ok(result.patterns.length > 0)
  }
  const denied = fixture(t, { bash: { "*": "allow", "rm *": "deny" } })
  await assert.rejects(denied.authorize("echo $(rm local)"), /host denied bash/)
  await assert.rejects(denied.authorize("'rm' \"$FILE\""), /host denied bash/)
  assert.ok(denied.calls.at(-1).patterns.includes('rm "$FILE"'))
})

test("Bash canonical literals normalize quotes, escapes and continuations without changing execution", async (t) => {
  const f = fixture(t)
  for (const [command, canonical] of [
    ["git 'push'", "git push"], ['git p"u"sh', "git push"], ["git p\\ush", "git push"],
    ['git pu\\\n"sh"', "git push"], ['git "pu\\\nsh"', "git push"], ["git \\\n push", "git push"],
    ["rm\\\n local", "rm local"], ["echo a\\-b a\\/b", "echo a-b a/b"],
    ["2>&1 git 'push'", "git push"], ["'hashless' argument", "hashless argument"],
    ["zellij action write-chars \"\"", "zellij action write-chars ''"],
    ["git 'push origin'", "git 'push origin'"], ["git push\\ origin", "git 'push origin'"],
    ["printf ''", "printf ''"], ["printf 'hello world'", "printf 'hello world'"],
    ["printf '%s' value", "printf '%s' value"], ["echo 'a b'", "echo 'a b'"],
    ["echo \"a\\\"b\"", "echo 'a\"b'"], ["echo 'a'\\''b'", "echo 'a'\\''b'"],
  ]) {
    const result = await f.authorize(command)
    assert.deepEqual(result.patterns, command.trim() === canonical ? [canonical] : [command, canonical], command)
    assert.equal(result.command, command)
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  }
})

test("Bash quoted literals preserve characters without interpreting shell syntax", async (t) => {
  const f = fixture(t)
  for (const command of [
    "echo '$HOME'", "echo '$(rm local)'", "echo '; | > & < ( ) !'", "echo '[x] {a,b} ~ ` # '",
    "echo literal\\;value", "echo brace\\{value\\}", "printf '%s%%' value", "echo '%n'",
  ]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.ok(result.patterns.length >= 1, command)
  }
})

test("Bash leaves builtin state changes and printf formats to the authorized shell", async (t) => {
  const f = fixture(t)
  for (const command of [
    "hash -p /bin/false innocent; innocent", "printf -vPATH /tmp; git status",
    "printf '%n' count", "printf -- '%+05n' count", "printf -- '%s' '%n'",
  ]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  }
})

test("Bash external cwd uses realpath and the host dir/* permission shape", async (t) => {
  const f = fixture(t)
  symlinkSync(f.external, join(f.directory, "outside-link"), "dir")
  const result = await f.authorize("git status", { workdir: "outside-link" })
  assert.equal(result.cwd, f.external)
  assert.deepEqual(result.directories, [f.external])
  assert.deepEqual(f.calls[0], {
    permission: "external_directory", patterns: [join(f.external, "*")], always: [join(f.external, "*")],
    metadata: { command: "git status", directories: [f.external], patterns: [join(f.external, "*")] },
  })
  assert.equal(f.calls[1].permission, "bash")
  f.context.directory = f.external
  assert.equal((await f.authorize("true")).cwd, f.external)
})

test("Bash worktree siblings stay internal but '/' never disables the external gate", async (t) => {
  const f = fixture(t)
  assert.deepEqual((await f.authorize("true", { workdir: f.external }, { worktree: f.root })).directories, [])
  assert.deepEqual((await f.authorize("true", { workdir: f.external })).directories, [f.external])
  await assert.rejects(f.authorize("true", { workdir: join(f.root, "missing") }), { code: "ENOENT" })
  writeFileSync(join(f.directory, "file"), "contents")
  await assert.rejects(f.authorize("true", { workdir: "file" }), { code: "O4E_BASH_INVALID_ARGUMENTS" })
  await assert.rejects(f.authorize("true", {}, { directory: "." }), { code: "O4E_BASH_INVALID_ARGUMENTS" })
})

test("Bash known file commands resolve operands, quoting, links, and missing descendants", async (t) => {
  const f = fixture(t)
  for (const command of ["rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"]) {
    assert.deepEqual((await f.authorize(`${command} '${f.external}/file-name'`)).directories, [f.external], command)
  }
  assert.deepEqual((await f.authorize(`cd '${f.external}'`)).directories, [f.external])
  assert.deepEqual((await f.authorize(`cat ${f.external}/file\\-name`)).directories, [f.external])
  assert.deepEqual((await f.authorize(`cat ${f.external}/'file-name'`)).directories, [f.external])
  symlinkSync(f.external, join(f.directory, "link"), "dir")
  assert.deepEqual((await f.authorize("touch link/new/file")).directories, [join(f.external, "new")])
  symlinkSync(f.external, join(f.directory, "file-link"), "dir")
  assert.deepEqual((await f.authorize("cat file-link/../outside/file")).directories, [f.external])
  symlinkSync(join(f.external, "missing"), join(f.directory, "dangling"))
  assert.deepEqual((await f.authorize("touch dangling/file")).directories, [])
  const command = "cat /dev/null/child; printf OK"
  const result = await f.authorize(command)
  assert.equal(result.command, command)
  assert.deepEqual(result.directories, [])
  assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  mkdirSync(join(f.directory, "-outside"))
  symlinkSync(f.external, join(f.directory, "-outside", "link"), "dir")
  assert.deepEqual((await f.authorize("cat -- -outside/link/file")).directories, [f.external])
})

test("Bash redirects inspect external files and retain host redirected_statement resources", async (t) => {
  const f = fixture(t)
  for (const operator of [">", ">>", "<", ">|", "&>", "&>>", "2>"]) {
    const command = `echo ok ${operator} '${f.external}/file'`
    const result = await f.authorize(command)
    assert.deepEqual(result.directories, [f.external], command)
    assert.deepEqual(result.patterns, [command, "echo ok"], command)
  }
  assert.deepEqual((await f.authorize("echo ok 2>&1")).directories, [])
  assert.deepEqual((await f.authorize("echo ok 2>&-")).directories, [])
  for (const command of ["2>&-", "2>&1", "(echo ok) 2>&1", "echo ok | cat 2>&-"]) {
    const result = await f.authorize(command)
    assert.ok(result.patterns.includes(command), command)
    assert.ok(!result.patterns.includes("*"), command)
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  }
  for (const command of [`echo ok | cat > '${f.external}/file'`, `(echo ok; cat) > '${f.external}/file'`]) {
    const result = await f.authorize(command)
    assert.deepEqual(result.patterns, ["echo ok", "cat", command])
    assert.deepEqual(result.directories, [f.external])
  }
  assert.deepEqual((await f.authorize(`> '${f.external}/file'`)).patterns, [`> '${f.external}/file'`])
  const chained = `echo ok > '${f.external}/file' && rm local`
  assert.deepEqual((await f.authorize(chained)).patterns, [`echo ok > '${f.external}/file'`, "echo ok", "rm local"])
})

test("Bash redirection placement preserves operands and external-directory authorization", async (t) => {
  const f = fixture(t)
  const file = `${f.external}/file`
  const splitFile = `${f.root}/out\\\nside/file`
  for (const [command, canonical] of [
    [`cat '${file}' > local`, `cat ${file}`],
    [`> local cat '${file}'`, `cat ${file}`],
    [`cat > local '${file}'`, `cat ${file}`],
    [`echo ok | cat > local '${file}' | echo done`, `cat ${file}`],
    [`true && echo ok | cat > local '${file}'`, `cat ${file}`],
    [`false || cat > local '${file}'`, `cat ${file}`],
    [`! cat > local '${file}'`, `cat ${file}`],
    [`cat 2>&1 '${file}'`, `cat ${file}`],
    [`cat 2>&- '${file}'`, `cat ${file}`],
    [`cat > $OUTPUT '${file}'`, `cat ${file}`],
    [`cat > local ${splitFile}`, `cat ${file}`],
    [`cat before > local '${file}' 2> errors after`, `cat before ${file} after`],
    [`cat <<EOF '${file}'\ntext\nEOF`, `cat ${file}`],
  ]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.deepEqual(result.directories, [f.external], command)
    assert.ok(result.patterns.includes(canonical), command)
    assert.equal(f.calls.at(-2).permission, "external_directory")
    assert.deepEqual(f.calls.at(-2).patterns, [join(f.external, "*")])
    await assert.rejects(f.authorize(command, {}, { permission: { external_directory: "deny" } }), { code: "O4E_BASH_PERMISSION_DENIED" })
  }
  assert.deepEqual((await f.authorize(`echo ok > ${splitFile}`)).directories, [f.external])
  // Trailing words belong to the command, so echo arguments are not file paths.
  for (const command of [
    `echo > local '${file}'`, `cat local | echo > local '${file}'`,
    `cat local && echo > local '${file}'`, `cat local || echo > local '${file}'`,
  ]) assert.deepEqual((await f.authorize(command)).directories, [], command)
  const denied = fixture(t, { external_directory: "deny", bash: "allow" })
  await assert.rejects(denied.authorize(`cat > local '${file}'`), /host denied external_directory/)
})

test("Bash compound here-strings preserve text without inventing external file reads", async (t) => {
  const f = fixture(t)
  const file = `${f.external}/file`
  for (const command of [
    `{ cat; } <<< '${file}'`, `(cat) <<< '${file}'`,
    `for value in 1; do cat; done <<< '${file}'`, `{ cat <&3; } 3<<< '${file}'`,
    `{ cat; } <\\\n<\\\n< '${file}'`,
  ]) {
    const result = await f.authorize(command, {}, { permission: { external_directory: "deny" } })
    assert.equal(result.command, command)
    assert.deepEqual(result.directories, [], command)
    assert.ok(result.patterns.includes(command), command)
    assert.equal(f.calls.at(-1).permission, "bash")
  }
  for (const command of [
    `{ cat; } < '${file}'`,
    `{ cat; } <<< text > '${file}'`,
    `{ cat; } <<< "$(cat '${file}')"`,
  ]) {
    await assert.rejects(f.authorize(command, {}, { permission: { external_directory: "deny" } }), { code: "O4E_BASH_PERMISSION_DENIED" })
  }
})

test("Bash requires approval completion and propagates denial before any execution result", async (t) => {
  const f = fixture(t, { bash: "allow", external_directory: "deny" })
  await assert.rejects(f.authorize("git status", { workdir: f.external }), /host denied external_directory/)
  assert.deepEqual(f.calls.map((call) => call.permission), ["external_directory"])
  let approve
  let completed = false
  f.context.ask = async () => new Promise((resolve) => { approve = resolve })
  const result = f.authorize("true").then((value) => { completed = true; return value })
  while (!approve) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  approve()
  assert.equal((await result).command, "true")
  const denied = new Error("host rejected")
  f.context.ask = async () => { throw denied }
  await assert.rejects(f.authorize("true"), (error) => error === denied)
  delete f.context.ask
  await assert.rejects(f.authorize("true", {}, { permission: "allow" }), { code: "O4E_BASH_ASK_REQUIRED" })
})

test("Bash optional O4E permission can tighten but never replace host authorization", async (t) => {
  const f = fixture(t)
  await assert.rejects(f.authorize("git status && rm local", {}, { permission: { bash: { "*": "allow", "rm *": "deny" } } }), { code: "O4E_BASH_PERMISSION_DENIED" })
  await assert.rejects(f.authorize("true && rm\tlocal", {}, { permission: { bash: { "*": "allow", "rm *": "deny" } } }), { code: "O4E_BASH_PERMISSION_DENIED" })
  await assert.rejects(f.authorize("true", { workdir: f.external }, { permission: { external_directory: "deny" } }), { code: "O4E_BASH_PERMISSION_DENIED" })
  assert.equal(f.calls.length, 0)
  await f.authorize("git status", {}, { permission: { bash: { "*": "deny", "git *": "allow" } } })
  assert.equal(f.calls.length, 1)
})

test("Bash rejects oversized, missing, and invalid arguments before host ask", async (t) => {
  const f = fixture(t)
  for (const command of [undefined, null, 1, "", " \n ", "echo hi\0rm foo", "x".repeat(65537), `echo '${"\u00e9".repeat(32768)}'`]) {
    await assert.rejects(f.authorize(command), { code: "O4E_BASH_INVALID_ARGUMENTS" })
  }
  for (const timeout of [0, 1.5, 2147483648, "120000"]) {
    await assert.rejects(f.authorize("true", { timeout }), { code: "O4E_BASH_INVALID_ARGUMENTS" })
  }
  for (const description of [undefined, 1, ""]) {
    await assert.rejects(f.authorize("true", { description }), { code: "O4E_BASH_INVALID_ARGUMENTS" })
  }
  for (const workdir of [1, "", "bad\0path"]) {
    await assert.rejects(f.authorize("true", { workdir }), { code: "O4E_BASH_INVALID_ARGUMENTS" })
  }
  for (const args of [null, [], "true"]) {
    await assert.rejects(authorizeBash(args, f.context, f.options), { code: "O4E_BASH_INVALID_ARGUMENTS" })
  }
  assert.equal(f.calls.length, 0)
  const boundary = `echo '${"x".repeat(65529)}'`
  assert.equal(Buffer.byteLength(boundary), 65536)
  assert.equal((await f.authorize(boundary)).command, boundary)
})

test("Bash supports complete shell syntax while authorizing extracted commands", async (t) => {
  const f = fixture(t)
  for (const command of [
    "$COMMAND file", '"$COMMAND" file', "$(echo rm) file", "/bin/rm file",
    "eval 'rm file'", "source file", ". file", "f() { rm file; }; f", "bash -c 'rm file'", "env rm file",
    "command rm file", "builtin eval 'rm file'", "exec rm file", "time rm file", "alias x=rm", "set -e",
    "VALUE=x git status", "VALUE=x", "export VALUE=x", "if true; then rm file; fi", "for f in *; do rm $f; done",
    "echo ${VALUE:-fallback}", "echo $((1 + 2))", "echo $'escaped'", 'echo $"translated"',
    "cat $FILE", "cat *.js", "cat ~/file", "cat $(echo file)", "echo ok > $FILE", "cat <<EOF\ntext\nEOF", "cat <<< text",
    "cd /tmp && cat file", "cd", "cd -", "pushd /tmp", "cat --files=/outside/file", "cat > local /outside/file",
    `${"(".repeat(130)}true${")".repeat(130)}`,
  ]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.ok(result.patterns.length > 0, command)
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  }
})

test("Bash parser gaps and scripts without command nodes still require whole-source authorization", async (t) => {
  const f = fixture(t)
  for (const command of ["VALUE=x", "# comment only", "git status &&", "echo 'unterminated", "echo ok <> file"]) {
    const result = await f.authorize(command)
    assert.equal(result.command, command)
    assert.ok(result.patterns.includes(command), command)
    assert.deepEqual(f.calls.at(-1).patterns, result.patterns)
  }
  const denied = fixture(t, { bash: "deny" })
  await assert.rejects(denied.authorize("VALUE=x"), /host denied bash/)
})

test("Bash parser is safe across concurrent authorizations and never executes substitutions", async (t) => {
  const f = fixture(t)
  const marker = join(f.directory, "must-not-exist")
  const results = await Promise.all(Array.from({ length: 2 }, (_, index) => f.authorize(`echo '${index}'`)))
  assert.equal(results.length, 2)
  assert.equal(f.calls.length, 2)
  const substitutions = await Promise.all(Array.from({ length: 2 }, (_, index) =>
    f.authorize(`echo $(touch '${marker}') ${index}`),
  ))
  assert.ok(substitutions.every((result) => result.patterns.includes(`touch '${marker}'`)))
  assert.equal(existsSync(marker), false)
  assert.equal(f.calls.length, 4)
})

test("Bash build propagates pinned runtime parser dependencies and preserves target packages", (t) => {
  const f = fixture(t)
  copyInstalledDefaults(componentRoot, f.directory)
  const runtimeRoot = join(f.directory, ".opencode")
  mkdirSync(runtimeRoot)
  const packagePath = join(runtimeRoot, "package.json")
  const original = {
    private: true, dependencies: { "another-plugin": "1.0.0" }, scripts: { test: "user command" },
    devDependencies: { ...parserDependencies, "another-dev": "2.0.0" }, optionalDependencies: { ...parserDependencies },
    overrides: {
      "web-tree-sitter": "$web-tree-sitter", "tree-sitter-bash": { ".": "0.25.0", unrelated: "3.0.0" },
      parent: { "web-tree-sitter@^0.25.0": "0.25.10", unrelated: "4.0.0" },
    },
    resolutions: { "**/web-tree-sitter": "0.25.10", "parent/tree-sitter-bash": "0.25.0", "**/unrelated-*": "1.0.0", "@scope/web-tree-sitter": "1.0.0" },
    pnpm: { overrides: { "parent>web-tree-sitter": "0.25.10", "@scope/parent@>1>tree-sitter-bash": "0.25.0", unrelated: "1.0.0" }, unrelated: true },
  }
  writeFileSync(packagePath, JSON.stringify(original))
  execFileSync(process.execPath, [join(componentRoot, "scripts/installer.mjs"), "build", "--target", f.directory], { stdio: "pipe" })
  assert.deepEqual(JSON.parse(readFileSync(packagePath, "utf8")), { ...original, dependencies: { ...original.dependencies, ...parserDependencies } })
  const generated = join(runtimeRoot, "plugins", "opencode-for-everything", "adapters", "opencode", "bash-permission.mjs")

  // Simulate the host-installed modules without fetching or vendoring WASM assets.
  symlinkSync(join(componentRoot, "node_modules"), join(runtimeRoot, "node_modules"), "dir")
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { authorizeBash } = await import(process.argv[1]);
    const result = await authorizeBash({ command: "git status", description: "Generated runtime" },
      { directory: process.cwd(), ask: async () => {} }, { shell: "/bin/bash" });
    console.log(JSON.stringify(result.patterns));
  `, generated], { cwd: f.directory, encoding: "utf8" })
  assert.deepEqual(JSON.parse(output), ["git status"])
})

test("Bash build refuses dependency conflicts or linked manifests before generating runtime", (t) => {
  const f = fixture(t)
  copyInstalledDefaults(componentRoot, f.directory)
  const runtimeRoot = join(f.directory, ".opencode")
  mkdirSync(runtimeRoot)
  const packagePath = join(runtimeRoot, "package.json")
  const [name, otherParser] = Object.keys(parserDependencies)
  for (const manifest of [
    ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].map((field) => ({ [field]: { [name]: "0.24.0" } })),
    { overrides: { [name]: "0.24.0" } }, { overrides: { [name]: { ".": "0.24.0" } } },
    { overrides: { parent: { nested: { [`${name}@*`]: "0.24.0" } } } },
    { overrides: { [`${name}@>0.1.0`]: "0.24.0" } },
    { overrides: { parent: { [`${name}@>=0.1.0 <1.0.0`]: { ".": "0.24.0" } } } },
    { overrides: { [name]: { unrelated: "1.0.0" } } },
    { overrides: { parent: { [name]: "$other" } }, dependencies: { other: "0.24.0" } },
    { resolutions: { [name]: "0.24.0" } }, { resolutions: { [`**/${name}`]: "0.24.0" } },
    { resolutions: { [`parent/${name}@npm:^0.25.0`]: "0.24.0" } },
    { resolutions: { [`${name}@>0.1.0`]: "0.24.0" } },
    { resolutions: { [`@scope/parent/${name}`]: "0.24.0" } },
    { overrides: { [`${name}@npm:@scope/alias`]: "0.24.0" } },
    { resolutions: { "**/*tree*sitter*": "0.24.0" } },
    { resolutions: { "**/{web-tree-sitter,tree-sitter-bash}": "0.24.0" } },
    { pnpm: { overrides: { [`parent@1>${name}@*`]: "0.24.0" } } },
    { pnpm: { overrides: { [`${name}@>0.1.0`]: "0.24.0" } } },
    { overrides: { [name]: `^${parserDependencies[name]}` } },
    { overrides: { [name]: { ".": parserDependencies[name], parent: { [name]: "0.24.0" } } } },
    { resolutions: { [name]: `$${name}` } },
    // Selector parsing is shared; the second parser needs one direct conflict.
    { dependencies: { [otherParser]: "0.24.0" } },
  ]) {
    const content = JSON.stringify(manifest)
    writeFileSync(packagePath, content)
    assert.throws(() => buildRuntime({ target: f.directory }), /Bash parser/, content)
    assert.equal(readFileSync(packagePath, "utf8"), content)
    assert.equal(existsSync(join(runtimeRoot, "plugins")), false)
    assert.equal(existsSync(join(runtimeRoot, "agents")), false)
  }
  rmSync(packagePath)
  const outside = join(f.external, "package.json")
  writeFileSync(outside, "{}")
  symlinkSync(outside, packagePath)
  assert.throws(() => buildRuntime({ target: f.directory }))
  assert.equal(readFileSync(outside, "utf8"), "{}")
})
