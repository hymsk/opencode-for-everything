export function validateTaskControlArgs(args) {
  if (args && Object.hasOwn(args, "reason")) {
    throw new Error("O4E_TASK_INVALID_ARGUMENTS: reason is not supported; cancel requires only action and taskID")
  }
  if (args?.action !== "cancel") return
  if (Object.keys(args).some((key) => !["action", "taskID"].includes(key))
    || typeof args.taskID !== "string" || !args.taskID.trim()) {
    throw new Error("O4E_TASK_INVALID_ARGUMENTS: cancel requires only action and a nonempty taskID")
  }
}
