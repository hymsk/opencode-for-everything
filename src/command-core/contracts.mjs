/**
 * Host-neutral contracts for durable command execution.
 *
 * This module deliberately contains no OpenCode imports. Host adapters provide
 * authorization, persistence, notifications and the ShellProfile; the core
 * runtime owns execution identity and lifecycle only.
 */

/** @typedef {{
 * shell: string,
 * name: string,
 * kind: string,
 * direct: boolean,
 * args: string[],
 * detached: boolean,
 * }} ShellProfile */

/** @typedef {{
 * executionID: string,
 * done: Promise<object>,
 * snapshot: () => object,
 * cancel: () => Promise<object>,
 * }} CommandHandle */

/** @typedef {{
 * start: (input: object, context?: object, options?: object) => Promise<object> | object,
 * get: (executionID: string) => CommandHandle | undefined,
 * }} CommandExecutionPort */

/** @typedef {{
 * stop: (input: object) => Promise<object>,
 * inspect: (input: object) => Promise<object>,
 * }} ProcessTreeController */

/** @typedef {{
 * append: (chunk: Uint8Array | string) => void,
 * finish: () => Promise<object>,
 * snapshot: () => object,
 * }} OutputArchive */

export const COMMAND_CORE_VERSION = 1

export function assertCommandExecutionPort(port) {
  if (!port || typeof port.start !== "function" || typeof port.get !== "function") {
    throw Object.assign(new Error("O4E_COMMAND_INVALID_EXECUTION_PORT"), {
      code: "O4E_COMMAND_INVALID_EXECUTION_PORT",
    })
  }
  return port
}

export function assertShellProfile(profile) {
  if (!profile || typeof profile.shell !== "string" || !profile.shell
    || typeof profile.name !== "string" || !Array.isArray(profile.args)
    || typeof profile.direct !== "boolean" || typeof profile.detached !== "boolean") {
    throw Object.assign(new Error("O4E_COMMAND_INVALID_SHELL_PROFILE"), {
      code: "O4E_COMMAND_INVALID_SHELL_PROFILE",
    })
  }
  return profile
}
