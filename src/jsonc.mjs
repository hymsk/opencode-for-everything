// Remove JSONC comments without treating comment markers inside strings as comments.
export function stripJsonComments(content) {
  let result = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    const nextCharacter = content[index + 1]

    if (inString) {
      result += character
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      result += character
    } else if (character === "/" && nextCharacter === "/") {
      index++
      while (index + 1 < content.length && content[index + 1] !== "\n" && content[index + 1] !== "\r") {
        index++
      }
    } else if (character === "/" && nextCharacter === "*") {
      index++
      while (index + 1 < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        if (content[index] === "\n" || content[index] === "\r") result += content[index]
        index++
      }
      if (index + 1 < content.length) index++
    } else {
      result += character
    }
  }

  return result
}
