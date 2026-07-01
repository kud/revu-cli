// Annotation data model: the SavedComment shape, the comment-key encoding, and
// load/save of the `.revu.json` artifact. State (the comments map) is owned by
// the caller and passed in — this module holds no mutable state.

export const DEFAULT_EXPORT_PROMPT =
  "Code review — inline annotations per file and line. " +
  "Each annotation is an issue, question, or required change. " +
  "Implement all changes."

export interface SavedComment {
  file: string
  startLine: number
  endLine: number
  text: string
  side?: "old" | "new"
}

// Comments are keyed "file:side:N" for a single line, "file:side:N-M" for a
// range (N < M).
export const commentKey = (
  file: string,
  startLine: number,
  endLine?: number,
  side: "old" | "new" = "new",
) => {
  const lineStr =
    endLine !== undefined && endLine !== startLine
      ? `${Math.min(startLine, endLine)}-${Math.max(startLine, endLine)}`
      : `${startLine}`
  return `${file}:${side}:${lineStr}`
}

export const parseCommentKey = (
  key: string,
): {
  file: string
  side: "old" | "new"
  startLine: number
  endLine: number
} => {
  const colonIdx = key.indexOf(":")
  const file = key.slice(0, colonIdx)
  const rest = key.slice(colonIdx + 1)
  const sideEnd = rest.indexOf(":")
  const side = rest.slice(0, sideEnd) as "old" | "new"
  const lineStr = rest.slice(sideEnd + 1)
  const dash = lineStr.indexOf("-")
  const startLine =
    dash === -1 ? parseInt(lineStr, 10) : parseInt(lineStr.slice(0, dash), 10)
  const endLine =
    dash === -1 ? startLine : parseInt(lineStr.slice(dash + 1), 10)
  return { file, side, startLine, endLine }
}

export const isLineCommented = (
  comments: Map<string, string>,
  file: string,
  lineNum: number,
  side: "old" | "new" = "new",
): boolean => {
  const prefix = `${file}:${side}:`
  for (const key of comments.keys()) {
    if (!key.startsWith(prefix)) continue
    const lineStr = key.slice(prefix.length)
    const dash = lineStr.indexOf("-")
    if (dash === -1) {
      if (parseInt(lineStr, 10) === lineNum) return true
    } else {
      const s = parseInt(lineStr.slice(0, dash), 10)
      const e = parseInt(lineStr.slice(dash + 1), 10)
      if (lineNum >= s && lineNum <= e) return true
    }
  }
  return false
}

export const findCommentKeyForLine = (
  comments: Map<string, string>,
  file: string,
  lineNum: number,
  side: "old" | "new" = "new",
): string | null => {
  const prefix = `${file}:${side}:`
  for (const key of comments.keys()) {
    if (!key.startsWith(prefix)) continue
    const lineStr = key.slice(prefix.length)
    const dash = lineStr.indexOf("-")
    if (dash === -1) {
      if (parseInt(lineStr, 10) === lineNum) return key
    } else {
      const s = parseInt(lineStr.slice(0, dash), 10)
      const e = parseInt(lineStr.slice(dash + 1), 10)
      if (lineNum >= s && lineNum <= e) return key
    }
  }
  return null
}

// Loads annotations from the autosave file into the passed `comments` map and
// returns the saved export prompt (null when absent, so the caller can fall
// back to the default).
export const loadComments = async (
  path: string,
  comments: Map<string, string>,
): Promise<{ prompt: string | null }> => {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return { prompt: null }
    const data = (await file.json()) as {
      prompt?: string
      comments: SavedComment[]
    }
    for (const c of data.comments ?? []) {
      const key = commentKey(
        c.file,
        c.startLine,
        c.endLine !== c.startLine ? c.endLine : undefined,
        c.side ?? "new",
      )
      comments.set(key, c.text)
    }
    return { prompt: data.prompt ?? null }
  } catch {
    return { prompt: null }
  }
}

export const saveComments = async (
  path: string,
  comments: Map<string, string>,
  prompt: string,
): Promise<void> => {
  const saved: SavedComment[] = []
  for (const [key, text] of comments) {
    const { file, side, startLine, endLine } = parseCommentKey(key)
    saved.push({ file, startLine, endLine, text, side })
  }
  await Bun.write(
    path,
    JSON.stringify({ prompt, comments: saved }, null, 2) + "\n",
  )
}
