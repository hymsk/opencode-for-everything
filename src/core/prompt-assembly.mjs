export function assemblePrompt({ base = "", systemPrompt, injects = [], instructions = "" }) {
  const parts = []
  if (systemPrompt) parts.push(systemPrompt.trim())
  else if (base) parts.push(base.trim())
  for (const inject of injects) parts.push(`# ${inject.name}\n${inject.content.trim()}`)
  if (instructions) parts.push(instructions)
  return parts.join("\n\n")
}

export function nativeContextTail(source, marker) {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return ""
  const tail = source.slice(markerIndex + marker.length)
  const instructionIndex = tail.indexOf("\nInstructions from:")
  return (instructionIndex < 0 ? tail : tail.slice(0, instructionIndex)).trim()
}

export function assembleNativePrompt({ nativeSystem, source, marker, instructions = "" }) {
  return [nativeSystem.join("").trimEnd(), nativeContextTail(source, marker), instructions].filter(Boolean).join("\n\n")
}
