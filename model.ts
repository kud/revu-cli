// Annotation data model: the SavedComment shape, the comment-key encoding, and
// load/save of the `.revu.json` artifact. State (the comments map) is owned by
// the caller and passed in — this module holds no mutable state.

export const DEFAULT_EXPORT_PROMPT =
  "Code review — inline annotations per file and line. " +
  "Each annotation is an issue, question, or required change. " +
  "Implement all changes."

export type Severity = "blocker" | "concern" | "nitpick"
export type Status = "open" | "accepted" | "dismissed" | "resolved"
export type Source = "human" | "agent"

// In-memory annotation: the comment text plus optional triage metadata. The
// comments map is keyed by `commentKey` and holds these.
export interface Annotation {
  text: string
  severity?: Severity
  status?: Status
  source?: Source
}

// Serialised shape in `.revu.json`. All triage fields are optional so files
// written by older revu (or revu-vscode) load unchanged.
export interface SavedComment {
  file: string
  startLine: number
  endLine: number
  text: string
  side?: "old" | "new"
  severity?: Severity
  status?: Status
  source?: Source
}

export const SEVERITIES: Severity[] = ["blocker", "concern", "nitpick"]
export const STATUSES: Status[] = ["open", "accepted", "dismissed", "resolved"]

// Cycle severity none → blocker → concern → nitpick → none.
export const cycleSeverity = (
  s: Severity | undefined,
): Severity | undefined => {
  const i = s ? SEVERITIES.indexOf(s) : -1
  return i + 1 >= SEVERITIES.length ? undefined : SEVERITIES[i + 1]
}

// Cycle status open → accepted → dismissed → resolved → open.
export const cycleStatus = (s: Status | undefined): Status => {
  const i = STATUSES.indexOf(s ?? "open")
  return STATUSES[(i + 1) % STATUSES.length]!
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
  comments: Map<string, Annotation>,
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
  comments: Map<string, Annotation>,
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
  comments: Map<string, Annotation>,
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
      comments.set(key, {
        text: c.text,
        severity: c.severity,
        status: c.status,
        source: c.source,
      })
    }
    return { prompt: data.prompt ?? null }
  } catch {
    return { prompt: null }
  }
}

// Loads an external review file (same `.revu.json` schema) into the map for
// triage. Imported items are tagged `source: "agent"` unless they name their
// own source, and existing annotations are never clobbered (a human note on a
// line wins over an imported one). Returns the file's prompt and how many new
// annotations were added.
export const importAnnotations = async (
  path: string,
  comments: Map<string, Annotation>,
): Promise<{ prompt: string | null; added: number }> => {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`Import file not found: ${path}`)
  }
  const data = (await file.json()) as {
    prompt?: string
    comments: SavedComment[]
  }
  let added = 0
  for (const c of data.comments ?? []) {
    const key = commentKey(
      c.file,
      c.startLine,
      c.endLine !== c.startLine ? c.endLine : undefined,
      c.side ?? "new",
    )
    if (comments.has(key)) continue
    comments.set(key, {
      text: c.text,
      severity: c.severity,
      status: c.status,
      source: c.source ?? "agent",
    })
    added++
  }
  return { prompt: data.prompt ?? null, added }
}

// Serialises annotations. Triage fields are written only when they carry
// non-default information, so a review with no triage produces a file
// identical to the pre-triage schema (keeps the revu-vscode contract intact).
export const saveComments = async (
  path: string,
  comments: Map<string, Annotation>,
  prompt: string,
): Promise<void> => {
  const saved: SavedComment[] = []
  for (const [key, ann] of comments) {
    const { file, side, startLine, endLine } = parseCommentKey(key)
    const entry: SavedComment = {
      file,
      startLine,
      endLine,
      text: ann.text,
      side,
    }
    if (ann.severity) entry.severity = ann.severity
    if (ann.status && ann.status !== "open") entry.status = ann.status
    if (ann.source && ann.source !== "human") entry.source = ann.source
    saved.push(entry)
  }
  await Bun.write(
    path,
    JSON.stringify({ prompt, comments: saved }, null, 2) + "\n",
  )
}
