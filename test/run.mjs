import { spawn } from "node:child_process"

const args = process.argv.slice(2)
const verboseIndex = args.indexOf("--verbose")
const verbose = verboseIndex >= 0
if (verbose) args.splice(verboseIndex, 1)

const child = spawn(process.execPath, ["--test", `--test-reporter=${verbose ? "spec" : "./test/reporters/concise.mjs"}`, ...args, "test/*.test.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
})

child.on("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
