import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createAcceptance } from "./wait-guard.mjs"
import { resumeInspectionEvidence } from "./resume-acceptance.mjs"

export default async function (input) {
  const { client, directory } = input
  const packageDir = join(directory, ".opencode", "node_modules", "@opencode-ai", "plugin")
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
  const { tool } = await import(pathToFileURL(join(packageDir, pkg.exports["./tool"].import)).href)
  const { OpenCodeForEverythingPlugin } = await import(pathToFileURL(join(directory, ".opencode", "plugins", "opencode-for-everything.ts")).href)
  const hooks = await OpenCodeForEverythingPlugin(input)
  if (typeof hooks.tool?.o4e_task?.execute !== "function") throw new Error("Missing production o4e_task")
  const acceptance = createAcceptance({ client, directory, stateDir: join(directory, ".acceptance", "guard"), inspectionEvidence: resumeInspectionEvidence })
  console.error("O4E_RESUME_ACCEPTANCE_COMPOSITE_READY")
  return {
    ...hooks,
    tool: {
      ...hooks.tool,
      acceptance_wait: tool({
        description: "Acceptance-only fixed 45-second timer. At most two admissions per Task, BEGIN then MIDDLE. Before each call emit public assistant text starting with the stage on its own line and at least 256 bytes of harmless text. Missing public text is rejected before waiting. Never use reasoning or tool arguments instead. No shell is executed.",
        args: { stage: tool.schema.enum(["BEGIN", "MIDDLE"]) },
        execute: acceptance.wait,
      }),
      acceptance_evidence: tool({
        description: "Read mechanical acceptance evidence for your own inspect-child Session after status-only watch calls, progress inspect calls, one output read without reread, and four final o4e_task inspect calls (maxBytes 128): fresh forward, backward resume:true, forward resume:true, forward resume:true. Never supply cursor/cursors. Watch cannot receive resume/direction/maxBytes or carry progress text. Requires BEGIN/MIDDLE from inspect plus the original guarded execution evidence. Reports inspect gaps/unavailable and user-message interruptions as failures; only an explicitly fresh inspect may recover a gap, never claim lossless recovery.",
        args: { taskID: tool.schema.string() },
        execute: acceptance.evidence,
      }),
    },
  }
}
