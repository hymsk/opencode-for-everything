import { normalizeModelRefs } from "../../model-fallback.mjs"

// Hosts currently expose variant either on UserMessage or inside its model.
export function messageModel(message, input) {
  const model = message?.model ?? input?.model
  const variant = message?.model ? message.model.variant ?? message.variant : input?.variant ?? model?.variant
  return normalizeModelRefs([{ ...model, variant }])[0]
}

export function latestUserPromptContext(messages) {
  for (const record of [...messages].reverse()) {
    const info = record?.info
    if (info?.role !== "user") continue
    const resolved = messageModel(info)
    const { variant, ...model } = resolved ?? {}
    return {
      ...(typeof info.agent === "string" && info.agent ? { agent: info.agent } : {}),
      ...(resolved ? { model } : {}),
      ...(variant ? { variant } : {}),
    }
  }
  return {}
}
