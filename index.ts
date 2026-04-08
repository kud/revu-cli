#!/usr/bin/env bun
import {
  createCliRenderer,
  DiffRenderable,
  TextareaRenderable,
  SelectRenderable,
  TextRenderable,
  BoxRenderable,
  RGBA,
  SyntaxStyle,
  getTreeSitterClient,
  type KeyEvent,
  t,
  fg,
  dim,
} from "@opentui/core"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(`revu — interactive diff reviewer

Usage:
  revu [path]                   Review staged/unstaged changes in [path] (default: cwd)
  revu --against <branch>       Review all commits between <branch> and HEAD

Options:
  -h, --help                    Show this help

Keys:
  ↑↓ / j k                     Move cursor
  shift+↑↓                      Select range
  ↵                             Annotate line / range
  d                             Delete annotation on current line
  ] [                           Jump to next / prev hunk
  c C                           Jump to next / prev annotation
  n p                           Next / prev file
  { }                           Scroll annotation preview up / down
  ←                             Back to file tree
  e                             Export annotations to revu-review.md (with optional AI prompt)
  s                             Settings (theme, view)
  q                             Quit

Files:
  .revu.json                    Autosaved annotations (JSON) — do not edit manually
  revu-review.md                Markdown export for AI review (press e to generate)`)
  process.exit(0)
}

let againstBranch: string | null = null
const positionalArgs: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--against" && args[i + 1]) {
    againstBranch = args[++i]!
  } else {
    positionalArgs.push(args[i]!)
  }
}
const rawTarget = positionalArgs[0] ?? process.cwd()
const targetFile = await (async () => {
  try {
    const result = await Bun.$`test -f ${rawTarget}`.nothrow().quiet()
    return result.exitCode === 0 ? rawTarget : null
  } catch {
    return null
  }
})()
const targetDir = targetFile
  ? (
      await Bun.$`git rev-parse --show-toplevel`
        .cwd(
          rawTarget.includes("/")
            ? rawTarget.slice(0, rawTarget.lastIndexOf("/"))
            : process.cwd(),
        )
        .text()
    ).trim()
  : rawTarget
const prMode = againstBranch !== null

let fullDiff: string
let currentBranch: string | null = null
let commitList: string[] = []
const fileStatusMap = new Map<string, string>()

if (prMode) {
  try {
    fullDiff = await Bun.$`git diff ${againstBranch}...HEAD`
      .cwd(targetDir)
      .text()
  } catch {
    console.error(
      `Branch '${againstBranch}' not found or has no common ancestor with HEAD.`,
    )
    process.exit(1)
  }
  const nameStatus = await Bun.$`git diff --name-status ${againstBranch}...HEAD`
    .cwd(targetDir)
    .text()
  for (const line of nameStatus.trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t")
    const status = parts[0]!.charAt(0)
    const file = status === "R" ? parts[2]! : parts[1]!
    fileStatusMap.set(file, status)
  }
  currentBranch = (
    await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(targetDir).text()
  ).trim()
  commitList = (
    await Bun.$`git log ${againstBranch}..HEAD --oneline`.cwd(targetDir).text()
  )
    .trim()
    .split("\n")
    .filter(Boolean)
} else if (targetFile) {
  const relPath = targetFile.replace(targetDir + "/", "")
  const stagedOutput = await Bun.$`git diff --staged -- ${relPath}`
    .cwd(targetDir)
    .text()
  fullDiff = stagedOutput.trim()
    ? stagedOutput
    : await Bun.$`git diff -- ${relPath}`.cwd(targetDir).text()
} else {
  const stagedOutput = await Bun.$`git diff --staged`.cwd(targetDir).text()
  fullDiff = stagedOutput.trim()
    ? stagedOutput
    : await Bun.$`git diff`.cwd(targetDir).text()
}

if (!fullDiff.trim()) {
  const msg = prMode
    ? `No diff found between '${againstBranch}' and HEAD.`
    : "No diff found (neither staged nor unstaged changes)."
  console.error(msg)
  process.exit(1)
}

// ── Config ────────────────────────────────────────────────────────────────────

const AUTOSAVE_PATH = `${targetDir}/.revu.json`
const EXPORT_PATH = `${targetDir}/revu-review.md`
const DEFAULT_EXPORT_PROMPT =
  "Code review — inline annotations per file and line. " +
  "Each annotation is an issue, question, or required change. " +
  "Implement all changes."

// ── Types ─────────────────────────────────────────────────────────────────────

interface Theme {
  name: string
  bg: string
  headerBg: string
  headerFg: string
  commentMark: string
  inputBg: string
  inputFg: string
  mutedFg: string
  successFg: string
  addedBg: string
  removedBg: string
  contextBg: string
  treeBorder: string
  treeActive: string
  treeFocused: string
  treeInactive: string
  treeComment: string
  treeHeader: string
  modalBg: string
  modalBorder: string
  modalFg: string
  commentedBg: string
  cursorBg: string
  selectionBg: string
  syntax: Record<string, { fg: string; bold?: boolean; italic?: boolean }>
}

// ── Themes ────────────────────────────────────────────────────────────────────

const THEMES: Theme[] = [
  {
    name: "Palenight",
    bg: "#292d3e",
    headerBg: "#1b1e2b",
    headerFg: "#82aaff",
    commentMark: "#ffcb6b",
    inputBg: "#1b1e2b",
    inputFg: "#a6accd",
    mutedFg: "#676e95",
    successFg: "#c3e88d",
    addedBg: "#1a2e1a",
    removedBg: "#2e1a1a",
    contextBg: "#292d3e",
    treeBorder: "#343b5a",
    treeActive: "#82aaff",
    treeFocused: "#c792ea",
    treeInactive: "#676e95",
    treeComment: "#ffcb6b",
    treeHeader: "#343b5a",
    modalBg: "#1b1e2b",
    modalBorder: "#343b5a",
    modalFg: "#a6accd",
    commentedBg: "#2e2800",
    cursorBg: "#2d3555",
    selectionBg: "#1e2540",
    syntax: {
      default: { fg: "#a6accd" },
      string: { fg: "#c3e88d" },
      keyword: { fg: "#c792ea", bold: true },
      comment: { fg: "#676e95", italic: true },
      number: { fg: "#f78c6c" },
      function: { fg: "#82aaff" },
      operator: { fg: "#89ddff" },
      type: { fg: "#ffcb6b" },
    },
  },
  {
    name: "Tokyo Night",
    bg: "#1a1b26",
    headerBg: "#16161e",
    headerFg: "#7aa2f7",
    commentMark: "#e0af68",
    inputBg: "#16161e",
    inputFg: "#c0caf5",
    mutedFg: "#565f89",
    successFg: "#9ece6a",
    addedBg: "#1a2f1e",
    removedBg: "#2f1a1e",
    contextBg: "#1a1b26",
    treeBorder: "#292e42",
    treeActive: "#7aa2f7",
    treeFocused: "#89b4fa",
    treeInactive: "#565f89",
    treeComment: "#e0af68",
    treeHeader: "#292e42",
    modalBg: "#16161e",
    modalBorder: "#292e42",
    modalFg: "#c0caf5",
    commentedBg: "#2a2000",
    cursorBg: "#283457",
    selectionBg: "#1e2a40",
    syntax: {
      default: { fg: "#c0caf5" },
      string: { fg: "#9ece6a" },
      keyword: { fg: "#bb9af7", bold: true },
      comment: { fg: "#565f89", italic: true },
      number: { fg: "#ff9e64" },
      function: { fg: "#7aa2f7" },
      operator: { fg: "#89ddff" },
      type: { fg: "#2ac3de" },
    },
  },
  {
    name: "Nord",
    bg: "#2e3440",
    headerBg: "#3b4252",
    headerFg: "#88c0d0",
    commentMark: "#ebcb8b",
    inputBg: "#3b4252",
    inputFg: "#eceff4",
    mutedFg: "#4c566a",
    successFg: "#a3be8c",
    addedBg: "#1e3028",
    removedBg: "#301e1e",
    contextBg: "#2e3440",
    treeBorder: "#434c5e",
    treeActive: "#88c0d0",
    treeFocused: "#8fbcbb",
    treeInactive: "#4c566a",
    treeComment: "#ebcb8b",
    treeHeader: "#434c5e",
    modalBg: "#3b4252",
    modalBorder: "#434c5e",
    modalFg: "#eceff4",
    commentedBg: "#3b3000",
    cursorBg: "#374a60",
    selectionBg: "#2a3a48",
    syntax: {
      default: { fg: "#eceff4" },
      string: { fg: "#a3be8c" },
      keyword: { fg: "#81a1c1", bold: true },
      comment: { fg: "#4c566a", italic: true },
      number: { fg: "#b48ead" },
      function: { fg: "#88c0d0" },
      operator: { fg: "#81a1c1" },
      type: { fg: "#8fbcbb" },
    },
  },
  {
    name: "GitHub Dark",
    bg: "#0d1117",
    headerBg: "#161b22",
    headerFg: "#58a6ff",
    commentMark: "#e3b341",
    inputBg: "#161b22",
    inputFg: "#c9d1d9",
    mutedFg: "#8b949e",
    successFg: "#3fb950",
    addedBg: "#0d4429",
    removedBg: "#67060c",
    contextBg: "#0d1117",
    treeBorder: "#21262d",
    treeActive: "#58a6ff",
    treeFocused: "#79c0ff",
    treeInactive: "#8b949e",
    treeComment: "#e3b341",
    treeHeader: "#30363d",
    modalBg: "#161b22",
    modalBorder: "#30363d",
    modalFg: "#c9d1d9",
    commentedBg: "#3d2b00",
    cursorBg: "#1f3a5f",
    selectionBg: "#1c2e4a",
    syntax: {
      default: { fg: "#c9d1d9" },
      string: { fg: "#a5d6ff" },
      keyword: { fg: "#ff7b72", bold: true },
      comment: { fg: "#8b949e", italic: true },
      number: { fg: "#79c0ff" },
      function: { fg: "#d2a8ff" },
      operator: { fg: "#ff7b72" },
      type: { fg: "#ffa657" },
    },
  },
  {
    name: "Dracula",
    bg: "#282a36",
    headerBg: "#1e1f29",
    headerFg: "#bd93f9",
    commentMark: "#ffb86c",
    inputBg: "#1e1f29",
    inputFg: "#f8f8f2",
    mutedFg: "#6272a4",
    successFg: "#50fa7b",
    addedBg: "#1a3a1a",
    removedBg: "#3a1a1a",
    contextBg: "#282a36",
    treeBorder: "#44475a",
    treeActive: "#bd93f9",
    treeFocused: "#ff79c6",
    treeInactive: "#6272a4",
    treeComment: "#ffb86c",
    treeHeader: "#44475a",
    modalBg: "#1e1f29",
    modalBorder: "#44475a",
    modalFg: "#f8f8f2",
    commentedBg: "#3a2b00",
    cursorBg: "#44475a",
    selectionBg: "#373a50",
    syntax: {
      default: { fg: "#f8f8f2" },
      string: { fg: "#f1fa8c" },
      keyword: { fg: "#ff79c6", bold: true },
      comment: { fg: "#6272a4", italic: true },
      number: { fg: "#bd93f9" },
      function: { fg: "#50fa7b" },
      operator: { fg: "#ff79c6" },
      type: { fg: "#8be9fd" },
    },
  },
  {
    name: "Catppuccin",
    bg: "#1e1e2e",
    headerBg: "#181825",
    headerFg: "#89b4fa",
    commentMark: "#fab387",
    inputBg: "#181825",
    inputFg: "#cdd6f4",
    mutedFg: "#6c7086",
    successFg: "#a6e3a1",
    addedBg: "#1a3a2a",
    removedBg: "#3a1a2a",
    contextBg: "#1e1e2e",
    treeBorder: "#313244",
    treeActive: "#89b4fa",
    treeFocused: "#b4befe",
    treeInactive: "#6c7086",
    treeComment: "#fab387",
    treeHeader: "#313244",
    modalBg: "#181825",
    modalBorder: "#45475a",
    modalFg: "#cdd6f4",
    commentedBg: "#2a2000",
    cursorBg: "#313264",
    selectionBg: "#2a2a40",
    syntax: {
      default: { fg: "#cdd6f4" },
      string: { fg: "#a6e3a1" },
      keyword: { fg: "#cba6f7", bold: true },
      comment: { fg: "#6c7086", italic: true },
      number: { fg: "#fab387" },
      function: { fg: "#89b4fa" },
      operator: { fg: "#cba6f7" },
      type: { fg: "#f38ba8" },
    },
  },
  {
    name: "Monokai",
    bg: "#272822",
    headerBg: "#1e1f1c",
    headerFg: "#a6e22e",
    commentMark: "#e6db74",
    inputBg: "#1e1f1c",
    inputFg: "#f8f8f2",
    mutedFg: "#75715e",
    successFg: "#a6e22e",
    addedBg: "#1a2e10",
    removedBg: "#2e1010",
    contextBg: "#272822",
    treeBorder: "#3e3d32",
    treeActive: "#a6e22e",
    treeFocused: "#66d9e8",
    treeInactive: "#75715e",
    treeComment: "#e6db74",
    treeHeader: "#3e3d32",
    modalBg: "#1e1f1c",
    modalBorder: "#3e3d32",
    modalFg: "#f8f8f2",
    commentedBg: "#2e2800",
    cursorBg: "#49483e",
    selectionBg: "#2a2e20",
    syntax: {
      default: { fg: "#f8f8f2" },
      string: { fg: "#e6db74" },
      keyword: { fg: "#f92672", bold: true },
      comment: { fg: "#75715e", italic: true },
      number: { fg: "#ae81ff" },
      function: { fg: "#a6e22e" },
      operator: { fg: "#f92672" },
      type: { fg: "#66d9e8" },
    },
  },
  {
    name: "Gruvbox Dark",
    bg: "#282828",
    headerBg: "#1d2021",
    headerFg: "#83a598",
    commentMark: "#fabd2f",
    inputBg: "#1d2021",
    inputFg: "#ebdbb2",
    mutedFg: "#928374",
    successFg: "#b8bb26",
    addedBg: "#1e2e1e",
    removedBg: "#2e1e1e",
    contextBg: "#282828",
    treeBorder: "#3c3836",
    treeActive: "#83a598",
    treeFocused: "#8ec07c",
    treeInactive: "#928374",
    treeComment: "#fabd2f",
    treeHeader: "#3c3836",
    modalBg: "#1d2021",
    modalBorder: "#3c3836",
    modalFg: "#ebdbb2",
    commentedBg: "#2e2800",
    cursorBg: "#3c4a28",
    selectionBg: "#2a2a1e",
    syntax: {
      default: { fg: "#ebdbb2" },
      string: { fg: "#b8bb26" },
      keyword: { fg: "#fb4934", bold: true },
      comment: { fg: "#928374", italic: true },
      number: { fg: "#d3869b" },
      function: { fg: "#8ec07c" },
      operator: { fg: "#fe8019" },
      type: { fg: "#fabd2f" },
    },
  },
  {
    name: "Rosé Pine",
    bg: "#191724",
    headerBg: "#1f1d2e",
    headerFg: "#9ccfd8",
    commentMark: "#f6c177",
    inputBg: "#1f1d2e",
    inputFg: "#e0def4",
    mutedFg: "#6e6a86",
    successFg: "#31748f",
    addedBg: "#1a2e28",
    removedBg: "#2e1a28",
    contextBg: "#191724",
    treeBorder: "#26233a",
    treeActive: "#9ccfd8",
    treeFocused: "#c4a7e7",
    treeInactive: "#6e6a86",
    treeComment: "#f6c177",
    treeHeader: "#26233a",
    modalBg: "#1f1d2e",
    modalBorder: "#26233a",
    modalFg: "#e0def4",
    commentedBg: "#2a1e00",
    cursorBg: "#2a2540",
    selectionBg: "#221e36",
    syntax: {
      default: { fg: "#e0def4" },
      string: { fg: "#f6c177" },
      keyword: { fg: "#eb6f92", bold: true },
      comment: { fg: "#6e6a86", italic: true },
      number: { fg: "#ebbcba" },
      function: { fg: "#c4a7e7" },
      operator: { fg: "#eb6f92" },
      type: { fg: "#9ccfd8" },
    },
  },
  {
    name: "One Light",
    bg: "#fafafa",
    headerBg: "#f0f0f0",
    headerFg: "#4078f2",
    commentMark: "#c18401",
    inputBg: "#f0f0f0",
    inputFg: "#383a42",
    mutedFg: "#a0a1a7",
    successFg: "#50a14f",
    addedBg: "#d4edda",
    removedBg: "#fdd8d8",
    contextBg: "#fafafa",
    treeBorder: "#e0e0e0",
    treeActive: "#4078f2",
    treeFocused: "#0184bc",
    treeInactive: "#a0a1a7",
    treeComment: "#c18401",
    treeHeader: "#d0d0d0",
    modalBg: "#f0f0f0",
    modalBorder: "#d0d0d0",
    modalFg: "#383a42",
    commentedBg: "#fff4cc",
    cursorBg: "#c8d8f0",
    selectionBg: "#e8f0fe",
    syntax: {
      default: { fg: "#383a42" },
      string: { fg: "#50a14f" },
      keyword: { fg: "#a626a4", bold: true },
      comment: { fg: "#a0a1a7", italic: true },
      number: { fg: "#986801" },
      function: { fg: "#4078f2" },
      operator: { fg: "#0184bc" },
      type: { fg: "#c18401" },
    },
  },
  {
    name: "kud",
    bg: "#131a24",
    headerBg: "#0d1219",
    headerFg: "#0092ba",
    commentMark: "#f59e0b",
    inputBg: "#0d1219",
    inputFg: "#cdd8e8",
    mutedFg: "#6b7280",
    successFg: "#80d440",
    addedBg: "#0e2035",
    removedBg: "#1e0f0f",
    contextBg: "#131a24",
    treeBorder: "#2a4158",
    treeActive: "#0092ba",
    treeFocused: "#ff0174",
    treeInactive: "#6b7280",
    treeComment: "#f59e0b",
    treeHeader: "#2a4158",
    modalBg: "#0d1219",
    modalBorder: "#2a4158",
    modalFg: "#cdd8e8",
    commentedBg: "#241a00",
    cursorBg: "#1a3547",
    selectionBg: "#1a3d58",
    syntax: {
      default: { fg: "#cdd8e8" },
      string: { fg: "#80d440" },
      keyword: { fg: "#ff0174", bold: true },
      comment: { fg: "#6b7280", italic: true },
      number: { fg: "#ffaf00" },
      function: { fg: "#0092ba" },
      operator: { fg: "#5599cc" },
      type: { fg: "#b6d88a" },
    },
  },
]

// ── Diff parsing ──────────────────────────────────────────────────────────────

interface FileDiff {
  file: string
  raw: string
  lines: string[]
  status?: string
}

const splitByFile = (raw: string): FileDiff[] => {
  const blocks = raw.split(/(?=^diff --git )/m).filter(Boolean)
  return blocks.map((block) => {
    const fileMatch =
      block.match(/^\+\+\+ b\/(.+)$/m) ?? block.match(/^--- a\/(.+)$/m)
    const file = fileMatch?.[1] ?? "unknown"
    const lines = block.split("\n")
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    return { file, raw: block, lines }
  })
}

const fileDiffs = splitByFile(fullDiff)
if (prMode) {
  for (const fd of fileDiffs) fd.status = fileStatusMap.get(fd.file) ?? "M"
}
const files = fileDiffs.map((f) => f.file)

// Comments: keyed "file:N" for single line, "file:N-M" for range (N < M)
const comments = new Map<string, string>()

const commentKey = (
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

interface SavedComment {
  file: string
  startLine: number
  endLine: number
  text: string
  side?: "old" | "new"
}

let savedPrompt = DEFAULT_EXPORT_PROMPT

const loadComments = async (): Promise<void> => {
  try {
    const file = Bun.file(AUTOSAVE_PATH)
    if (!(await file.exists())) return
    const data = (await file.json()) as {
      prompt?: string
      comments: SavedComment[]
    }
    if (data.prompt) savedPrompt = data.prompt
    for (const c of data.comments ?? []) {
      const key = commentKey(
        c.file,
        c.startLine,
        c.endLine !== c.startLine ? c.endLine : undefined,
        c.side ?? "new",
      )
      comments.set(key, c.text)
    }
  } catch {}
}

const saveComments = async (prompt?: string): Promise<void> => {
  if (prompt !== undefined) savedPrompt = prompt
  const saved: SavedComment[] = []
  for (const [key, text] of comments) {
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
    saved.push({ file, startLine, endLine, text, side })
  }
  await Bun.write(
    AUTOSAVE_PATH,
    JSON.stringify({ prompt: savedPrompt, comments: saved }, null, 2) + "\n",
  )
}

await loadComments()

const isLineCommented = (
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

const findCommentKeyForLine = (
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

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_PATH = `${process.env.HOME}/.config/revu/settings.json`

const loadSettings = () => {
  const global = (() => {
    try {
      return JSON.parse(Bun.file(SETTINGS_PATH).textSync())
    } catch {
      return {}
    }
  })()
  return {
    themeIndex:
      typeof global.themeIndex === "number"
        ? Math.min(global.themeIndex, THEMES.length - 1)
        : 0,
    diffView:
      global.diffView === "split" ? ("split" as const) : ("unified" as const),
  }
}

const saveSettings = async () => {
  await Bun.write(
    SETTINGS_PATH,
    JSON.stringify({ themeIndex, diffView }, null, 2),
  )
}

const saved = loadSettings()
let themeIndex = saved.themeIndex
let diffView: "unified" | "split" = saved.diffView

// ── App state ─────────────────────────────────────────────────────────────────

let fileIndex = 0
let cursorLine = 0
let prevCursorLine = 0
let selectionAnchor: number | null = null
let focusedPanel: "tree" | "diff" = "tree"
type Mode = "normal" | "comment" | "settings" | "export"
let mode: Mode = "normal"
let commentTargetLine = 0
let commentTargetEndLine = 0
let commentTargetSide: "old" | "new" = "new"
let previewScrollOffset = 0

const getFiletype = (filename: string): string | undefined => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "css",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
    zsh: "bash",
  }
  return map[ext]
}

const theme = () => THEMES[themeIndex]!
const currentFileDiff = () => fileDiffs[fileIndex]!
const TREE_WIDTH = 38

const buildSyntaxStyle = (t: Theme) =>
  SyntaxStyle.fromStyles(
    Object.fromEntries(
      Object.entries(t.syntax).map(([k, v]) => [
        k,
        { fg: RGBA.fromHex(v.fg), bold: v.bold, italic: v.italic },
      ]),
    ),
  )

// ── Splash screen ────────────────────────────────────────────────────────────

const SPLASH_F1 =
  "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"
const SPLASH_F2 =
  "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"
const SPLASH_F3 =
  "iVBORw0KGgoAAAANSUhEUgAAANwAAADcEAYAAABLyhPCAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAAAAAAAAPlDu38AAAAHdElNRQfqBAQODSMcvoHmAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA0LTA0VDE0OjEzOjM1KzAwOjAw6Iy6cAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNC0wNFQxNDoxMzozNSswMDowMJnRAswAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDQtMDRUMTQ6MTM6MzUrMDA6MDDOxCMTAACAAElEQVR42uydd4BMVxfAf/fNzPbesGtZyyqr994logQhJEoiSvQIEYkEIXqLFiJqEoQ0RAuCiN671RaLZa21ve/OzLvfHzNDit0lBPG93x+eV255982+886555wLGhoaGhoaGhoaGhoaGhoaGhoaGhpPDfG0O/C08PbxyxdYSHcEiUTmf9NyNGSjZVt2p2VbbqRlWyrNsg1qYtn6fG7Z2vs97fvQ0ND4fyErybKNHWDZXt1q2Z5ztGxPjbZsT9e1bMNbWrbRy+PiYmIiI82Vn/YdPGmeewFnEWT5EyyCrLGz5Wh3q8Bq5PG0+6ehoaHxZPgt1rJd4mHZbk+1CL5oz6fds3+L50bAeefz8w8s4volJkyYWvWwHJ3cxbIN+O5p909DQ0Pj2eTm65bth8tRUFDWLYq7ExMdeS2l79Pu2aPynxVw3vn9AgKDA0pixIhxaAnL0Xd/ftr90tDQ0Hg+mNXOIvCmnrcIvJtnn3aPHpb/jIDz9vcLDCzms5csssj69KblaL/2T7tfGhoaGv8ffPEDBgzoRxWMi465GRkRW/tp9ygvnlkB5633sw90VyQeeODe29cyh/bFnafdLw0NDQ0NgH6eOOCA/YLEuJsx1yMvmZ92h/6G8rQ78Fe8C/oVCgwJMeCOO27X39AEm4aGhsazyBcJZJJJ1rXXvPP7BQQWCbF/2j36K8+MBmdxEumcZXESWW73tPujoaGhofGQCASiizkuNuZ25PVv9U+/O08JL+mnC3TWHRG++OA9+4pFU9Pm1DQ0NDSeD75YjQMOOAwsHHcz5npkuLnKk+7BExdw3t5+foGBTrMte7+OtWxrxzzpfmhoaGhoPAn2+uCMM04vjo67HhMReSH9nSfV8hObg7PGqc2z7J0Osmw1waahoaHxfFM7ljTSSD9d0LuQX5HAEjY58O/zr2twlkwiTp9bTJCnC1qOBrd5UjeooaGhofEscWW9RaMre9Wq0Q38t1r61wSct+JnCHTVHcETTzx2NrUcrR37b7WnoaGhofFfYq+fZY6u/qZ/a47u3zNReuGF5+xrlh1NsGloaGho/JHaMWSSSebsK/9WC49dg/P28ysQGNTZhBkz5uW6f3eANDQ0NDT+81jCC7Kt4QWPLZ7usQk47wC/QoEhIfYWiXwx8+mMkoaGhobGfxYDBvTF7SypwMKNj1rdI5sovR38XAK9dVgE2442T3t8NDQ0NDT+oxgxYtrxmkVhUuSjVvfoc3AuOOPcy8Oyoy1Lo6GhoaHxKAQssyhMvX0ftaZ/bKL8c3b/O7We9pBoaGhoaDxn6NGj990Xdzsm6p+sXvDPNTjLsjU3nvb9a2hoaGg8p5gwYbItj/bwPLQGZ8kaHRBqsZXeCHva96+hoaGh8ZyjoCAKloq7ExMdef3m+Qcv9rAYMWIaWvJp36+GhoaGxv8JKipyaImHLfbAGtzdXJImTJiS+zzt+9XQ0NDQ+D9DIBBu8y3xcil5yqEH1+BMmDC16vm0709DQ0ND4/8UiUS26vGglz+kiXJyl6d9fxoaGhoa/888uBzK00RpWQ0gf4JFct7yeNq3pqGhoaGhAQUS4+JiYiIjoz1zuiJvDU4ikY1dnvataGhoaGho3KOxc15XPKCJsnvi074VDQ0NDQ2Ne3RPy+uKHE2UFtOk7qhFgzNVetq3oqGhoaGh8Xf0Ry2myr+vJ5ezBieRyPyaU4mGhoaGxjNM/jdzOpOHiTJkw9PuuoaGhoaGRs6EbMzpTB4Cruzup911DQ0NDQ2NnCm7M6czeQi4cqOfdtc1NDQ0NDRyptzInM7kIeBKZTztrmtoaGhoaORMqRy9KfMQcEEvPO2ua2hoaGho5ExQk5zO5CHgfOY87a5raGhoaGjkjM/nOZ3JQ8DZuz/trmtoaGhoaOSMvV9OZ/75it4aGhoaGhrPMJqA09DQ0NB4LtEEnIaGhobGc4km4DQ0NDQ0nks0AaehoaGh8VyiCTgNDQ0NjecSTcBpaGhoaDyXaAJOQ0NDQ+O5RP+0O6Ch8Z/ARDYpIONklNwPHGQ9nYGdfCcbAKvkNGkAznNATgR5nv2MB+K5xSHAgAOeWJYYFoCRLBIBPXa4AkUoR08QhSkjugLVxct8B7ThXZEI1OM1sQ1EqKjDp4ArniIEECjaX7GGxv3R/jQ0/r9RUTGCDJdH5AzgSwbKvcAU2UnOB3mDi3I1iHUiUykAyjCdu937oOuoX+NUB/SV7CJczoPdXPsrHm1BX9zumIsKds0cenvPA10Dw2eO54A+zFRqAnY44g2sY4Z0ArlIdTXtAmP+rOCki2D8LHtGcgkwrc2umzIEjKuzdib+DqaY7OFp4WBeY0rN9AA5Tc00LgT5E1MkINowSKQAI8Ua5WMQLUV/bgFueIvS1nuVT3uwNTSeLCKnE97efn6BgVL7k9B4LpDXZZhcDoyjnZwEcqRspg4FMVFsV74EnVlf3tEV7Po6ZnsPAKcmrlkF3cHpV3d9kZHg/JX7laBQcBrt2jJwD9hPcv4s30kwFLev6j4P9PXtklzDQUlSNtldBeWwbpxhEIhk0VYXDtjjhC2hkADMmEgHlvGJjAZ1jHrb9DHIBaqzcQ+Yq5nyZ04H045s55RAyN6aUSvOABl30tZEj4P0TUkLroZD2qWkPhGNIa1/UrmrSZD5Y2qHqL1gdM/yTXIA2VZdaYwFQqklRgELxUXlLIgXRTdxGotm6WEZIk0AavxXiYuLiYmMFH+TZ5qA03iukGFytxwJdJWF1QLAMbbSF5Sl+jUO2eAQ7ky+Q+Ca4hVUsjq4l/WtXy4N3DZ4Vyg1BpwqujcpfBns8jlM9BoMunP6LMf5IGKVFrojgBNuFAY2ynkyEORmFsoQYJNcIIsC1whjGXCLS6wHUoiX5+/XUatAMWAv3AFfCtEA8KEgdYDyNBTTgZfE21wA8QqDRTpQRTQTi4Ft8htZCdSh6jnjq2A6k10qtStkuqZFRN+B1A0JB8N3QdLeOz+djICkandanqkGaS8mmSMmgLFUVo2k9sBr0kdVgB9Fos4eREcxQrhY+mUVfJrmp/HMowk4jecDgUAHxMkouQ9kP8rJ2sDPcoZ0AV1vwx6n1uB83D24yHbwbJa/UpXXwMvJv3H15eDa3GtByXrg4OsU4/seKK10tezNgA+Bog7IsbRRxwOL5FB5CrjIIaYBRrJk0tO++fuMgyteojjQkM7sBTFcrFI+ALqI0cIXZD51q7kBmIZmL0uuC2nNksTV6ZBQP3rK0QYQVzxq0f7bkJwR2+nsaMg2Zc6J2w98IpvLD4AtQqdUAFFRvCDmAhIV89O+eQ2NP6MJOI3/JgKBAnK7XCarA/VlsroZxBpdJ0M+cIp2jSgEePsH/FYrHHy/C4ytNxPc6vrEly4EdvEOL3ulgriq1NJ9B3KQrKa2AGbI7vIHIIpLct3Tvsl/BYuGaIej8AYa8QYHQSwW4cpFwJMCVAHTPFPN9J8gLStxZsQCiBtz85e9GXDn4vWev6dC8tS4Uufqg7mF8UTaXmCa2C1WghgivlG6ADrscPlDexoaTwFNwGk8+wgsr0kzyPlykLofGCxryDagn2c/wO0meLT0O1mxM+RfHlzgpQXgvco/pMZMcNA718z/AggPMVJfE2Q76aamASsZJ5MBIxkywdqK+Mc9fH6QSFSgNHXEGBArxG0lAzBjJA2MGVkpSb9DYp+Y0if2Q3SFiB82X4O49jc+3DsIMt9N73s7H5BBCjdALBDnldOAE64U/EP9GhpPgJwEnOZFqfH0sP0cJcgZspv6HfC1HC4jwL6v01TfvuCzNHBZvS/Af14xp1ajwf2y77xy7qA/a7ji4gNyOo3U28B46SvLgUyVk01XgaUWze8+rT2t+/xr+/I+/3uSfbKMz1n2ytEgK0jMEkvYgQH0L9n1dL0IvjsCXRqUBW/PgPW1PofUc4llL2dC9J4rXr+MgNvDI7y37IW0M0m7riUCU+gsF4BYLqKUZMDB6lyjCTyNp4CmwWk8WRTLC1R+Kz+VscBo+bI6Auzfcn7VryPkKx30btNQCOgScqv1GXBt572yVEdQrirfGH4GWUvGqCuBQ2yQXXgacWAWU5wbPiIUaE5fIkF8KL5VegGtxbsiAfAhkPrAObmPscBeVsuXgXSSuA5UoAmzgJqijVgFGMkkEdgv18pXQU6hk5wPLJUj5Q3gJhflz3d78GTv1gzko7BoAmK1SFU8QU6VXdRFkDEkZWmkD9z6/YrrppkQFR7+9trjkKZLWhKxBTjKFtkHxFSxW/nW+vztnsJ9aDzXaCZKjaeDgg47kCflb/I9oJ5MVNeDYaXDHc8gyGcOKv/i1xA4q6S5w1hw/cbbt1RTUKopa/Xfg2wg09TtQDSX5UaenECzaRye5BdVsMw9rQAxglXKh6AOV68ae4HRIytfkhtkdUh/8fYhyMxM3Rm9CjJ902KiDWAqZvwy9WUw1zEFZy4FxsjW6lhQWuir2SeBrqZ+rNMusM9y2u0bBA4FnF/LPwEcy7u8X+AAGCId6nmdBl1PXUf7+kA4R5gJ8nXpowrgPAflJO45nTypcbHHSfgBc8Rx8RuWsIdMyKiR3CqyK9zsGP7zmmYQ9WN48M8NIKNE6uKblYF3mK+0ANFefCh0gIqZrCfQb43nGk3AaTwZbKavTNKIBllXTTCvA+U7/WYHZ/CxL+hU9zsonFSm7Zu/gOcH+ZwrXgDluDLJbjjIujJBXQvEYckY8qRe3CpmjEApaokRIA6I/MoboM5UzaYVkLE7xeOGHhLa3l5xdAQkfHxr2OF4SPk9fsj5q5BZOy3o9jAwVTL+lPoRqJXMHxknAxNke3UGEMk5VgLZZBIP+BNCG+5qcGKwote/AboEfUHHSLBf6FjfR4DLBs8exd4Dj9/yDaq0Ebz2FLhS7Qi4LPJoWLQU6Lz1rZzagGwlHcxRwGqmSTuepGZr0Wj12OMKfCnOKEeBz2UfuRFSZyTMudgWrtc623ZFGETHX3l5kz8Yb2dFJM0BTotSyqcgCoiioiUWL03TE+m3xnOEJuA0/l106HEA+bX8WF4FUoiTZ8Htfe9zpXZC4Z1lhrxVCvLNDVryQk/Qnzd0c14OsrQ8p44ArmMJxH5yGprlRepLIdEAxBERqPSzalrfQGK5mAsnfOHWK1fe21gP4k7eDNl3GzK3pw68lQXqQPWYsT6IdrwvTMAw8Z3SH6jHa2wD4ScKiYZYUnG53W3zfv2wmAAT5W15DORpdvIxMId+cgvIybKjOg/ETuGqNAW7Kw41vPaDR7V8ayvmhwJDgms1dwLvKQW71CkPdmPsf/FYDbK5FOp5YD8/y3ZYNGn7JzKuFg3PGQ8RDGK7sFdqgVpTHZu9BOI3RPU4OA8i+p/qsbgdxBe9ZT50A+Rt+bF5I4iZ4pCyEU3QaTwUmoDTeLzYNLU0EuUVkOXUcHU8GOo7vO4RCQGFi2e1DYHCo0LXdekCjiVcTxTcAvINGaC6Azv4Vtbhyb14bVhNaYwS65RPgfLyknkiJJa6feqEHVxPOnvn2wy4c/7Ggd1pYCqUVSq5CjBILBavghgjNompWFJgleLJOE8IwISRFJAr5ViZCrSS9uZIUD7Vf+owFzxm+R4uXxwCR4a+1LEV+LYudLbhFNDX0o9z2gOyoUwz/w6YyCLp7hP897GmQqMIZUV3EGdEKWUMZL+YaUr4EW4euRizeiFc6xFWbNlLkDk41RDlB+wWnkprEIWFJTentNajoXEfNAGn8XiwaWob5FzpDyQRyxnwWOeXVX4yFE2oGN3vEHj3CihVexeI8spK3RygjyyjVvlLXU/Gr9FiQnPARRQAcUwUUQZD5o/pW2MOwfWZYW8vPw032l1s8FM5yH49fXXsWWCDMCnBIFqIvuI6z54XoFXTlVfkcTkPCJVh6jDQlTIMcJwNflcLfdO4IRSZU1739npwres9qaQfMEV2louAc+yX47jr9PPEsM25vS0+UypxVwAmVb/T8nR1uNLp+Kh5PnBnyI3au3aBvKj2NI0D8Yn4WfkEywdKxtMefI1nDU3AaTwa1rkw2VLqzRGgm29wco6CggOL927nBUW+Lreqx3FwaOw8s4ABZGl5Vv0IiOSc/J4n7+1oM3EVpqx4CxggvhAvQOL3t4OOj4fwZUfWTj8P8ctvrT/yDnCcrbI/iCHia6Uz9zSP/wpWTVgekOvka0AzKdXT4DTAfV7hWVD0nYoLBrSEAp8Ubda8NIiqYq3+B2A5o9RoLB8ujk+wv/dMme4iCMRpUVIZDcaiWRWSmkDka+ev/lAFrnU489PXBSCrQvqHd94CEaaE6sYDjrjgz7P34aHxVNAEnMbDYXPuiJe35CGQNWS0+g04zXE/EeQMxWZXOjJgK+Q/UKTFS3oQu3QfGF4F3pGV1IY8uOnR9kVfl/ZiC+BHYRoBPzFV6rmrMT4wNsFWnsZiJrCCT2UcRI+O8N9yDi5uOdR3mhdk/JbifCMdxDWllvId4I6vKMfz9cIUIJtJzGGgP2d4y+UbCDpeZtJbHSCof7kePcqCrrthm1N9YKLsoM4CdBhweog2jGSTDLzAW+Ik0E1MEsWBvrKMrAKkkSSvcc+knRM2zexNximBwAHWyg4QPyeq2oFqEK4/WmOmCRIHx9Q8GQl0Z5IoDqKcaCg+w/I7yn7aA67xtMhJwGkLnmr8GZsmsEf+JJuBvMoZvgIfY8HsuuOhfKlGhhmnwX9zMdEqEsQbSrQ+CItga0Tegu2vX+4XRSXdF2Aqa1yR1h+y12WWjYsBytFATH6IftucNUpRS4y0puRqCZFrz3f9oSmcvbXXc/SnkGFO7X5zA4gk5RXdRSzxbGV4vgTbvTFB/Cr0uspgGmsslP4uXD540n9+Nwg/cOTGjKZgyp89KbUM8IFYofTi4U2A3ZigFIM0u6SlEbsg5VDc6PNGoCJNmAsMEouUV8g7HMCmQS5nlHqbu+voeVcKiKgVDOViGq6e7gsB50I+f6UZKE2UffrzIGfLXup6Hl4wa/xfkKMDtpOTs7O7++jRT7uDGk8I6wtCTpKvqXNAQXfE/jMI3Fpqy2t6KJlRc8hHk8F5hnvToEyQ1WWUeTEQTQQ1yNsEaXPu6CWmK5UBN+bwIyS53rl8sjJcPXKq+uIh4HzKY2VwU3D41gnfZUBZnGVeYQIS8KGgqAsUpARtIWp0+PrVteBC6KGlU7uBKTxbTY61ZthIAlRrf/4pwuKkIaPlbWIAJ1zkbCDdUqs4I06L44ATTrma/qyrCqin1QsyGmSsTJKjAQMGDMAJjotDIKaLz3D9B/20arRirdgtvED2lj+olSDZPrbumVAw/2KKypgKnnb5O1SeCUoF5Q1DIHCG3ZjIO0zDGthunpX9SaovXJhxqNlkV8hYnZJ6oyk4l/YoGnwa9EcNbV0UIAToD6QQx+v8XbO7F2aSSi/AiYuyANh1tD/oXha8uwbcqbUCdA0Nbk6vQ/LeuDlne4O5uEnJvAziojALd+598Gj8X5CRkZaWnPzpp389rmlw/+9Yv5xtuRsNWfZp7q5QvHuVDoOrQ4nj1doPnQx2MxzL+1wCWUQeML+BxasvzVrH/QzdNo3IFS9RAsQNUV+3FoznMg8kdoOIzFO7FqXD8eLbFg1wA35iilTApbNny5D+Fg1MNn+A/lszY4jvRIySDXdKRZ7eeQPCjx6JndkBTFuz7VK8QMwRJ5RdWHItpv+DcbLHHnuQneQbsheYpdnNXBXYyz55EBw/c+jpkAqubq4nXIqB8BXuAiCRRO63CoEJEybAHXfcwOegTz+vXhAwO8DNfxm4fuBazWUc8Bs75C4wLzOvNh8DeVVeldet9/0wf73WOUVRT3QQv4JsZgkjuD7+3NYVW+Dal2ccvrkO0ll+rxYAilFJDLj7LHNmvGynTgWnU26/F/oNvJb756/5Hlzqfix4bmE40XX7K4N2QOz1G2G7va0fUJ8DQ8RS5U3y1hhtiQKsv09dIf0bjoOgyAflhvR4BUrvq3P906ngOMy1YcHVIEPVM+Zhf6lXyz36f4sm4P7PkSXVU+bB4LjJpZJ/dyj9bu1+n46Hwi5lhr3pCEpzXRX7eGCwrKG+Qt6mINuLpQPDhA4oRiUGQEJEtOFIEJz67fe670dD+PAjH83oCvKS2sc8DQq6l2je3gTKSqWNQQLRXJGb8mgnE8R24airAylfJ6y6OBEuLj/UYtpJyCqd/u6dViC+EVeVKP65YHPBBWdQh6gfq9PBMdRROo6Hxt0aFar3HXzy4fDCQ3+C+Snz8k+vBVPqTFz56TTw6uKl9/QG9YR6Vo26z7hbBZ/cK/fJg9Btc9eYTkmwYszSfguiYZEyP98sL/i4y4f5BodD+bByaWWmgXAXHsId5Bq5Vm7knwu6+uJ18RvIX9VqpmCIGHH64yXj4bb+6qlf3waxQJxTTnI3N2Wu9WWD3Mdq2QryLyni2XQSOEe41ygSB/HjogofMMDJnTsavp8Al186JuechuzgjAPxNUFcEOV1swA7HISXZWjuK1BtJsyfmCIF0IvpoirkP1Oky0uhUG5cg81TzoL7Kd8dZa+BLK+GmydyNx4zzzlAjecS7ZH/P2GJp8omGWRZ9YL5U3A94hVTYieUqVMvYUI25EsJnvDSROAVBosU4Be+lIXJ3dlDctfdXOwTProOYHIwvpdqgqtrT+9dUhJOTPtt5uCXIPZM5O7d0aDeUAebvgGflwJ71h0ArtW9R5XUg6wnE9W8UnJJoBm9xWUw6bMHpCbC5Y+PvTC3L6SeSEgKLwDirFJGN4U/a5oPgx49elBHquPULyHfer+mvgXh03OfDPzwBMwY+tm+Cb3gjfldLrzmCHVn1OlTqz6U+aX0zZLfgkMVB1f7b4APGMao+9SvoqICqaSSBq4TXJu4fA6BYYEt/E9A5fBKtyq0gG6l3nq9UyeYO2P2gSkh0GJi88AXawOnOEUYyFvyFtH/4P6sThmit5il1ATT51nHkhfA5R7His0pBql9E/ddjgaxVmTo/LiX6SWn39UI2VQOBod+Lvv9h4PfO0G9G8eBSFNe190C496sNYml4cqlk1XmL4TT5X6/OLQ2JB6+s+lUMvCFOC32A6HUEaNzac/2u7jKKbkY5FsySBYEz1v5fqhcEcqa65snNQLvcQXb1i4AcqbsKdeAvCnD5VqeXGYcjWcCTcD9PyCwpM6KAllDjTYvA/fP/Y6VLwNlUurHTQoG7wj/fjWLAQNkRdkAiOCUXELOgsbmrViAYNECxEHhr+sOKacT0sKLwJnQ3d+MqAsXFx/5fsZ+yLqd7hMzCdgnfJXXQf+2Yadzc8i/pkjJl7aA4qZcs6+FJanwmlzuxerEIgaIeUpTuFX+SqMN5yHG/9rr29cA24S9UpNHfpHJ1XKNXA+G5Ybphleg9+u9+r3lD20atN7R4itwrObg7rAMMo5nGDPeh03Rm1/cZg+fd/jizYWpkHA6ISTRHoSf8BT3+SsTrrjiCqK9aCdaw+qANd+tvwOfNBi9atLrcDr+zL6z+UCNVpOlK+Sfn79YvqswOOBdc9+yEPJDMWNwflBV6aAWfYTfhlXjFvsUX91rkBqc0OOSO1z96tRPS5LAvNd8LasBUJIa4qNc6skmQ8aDeJ9l4i3wcy58qfEusNvl4O45kLvJmuV1eVaugFj3G357FsPJuN/yDX4HojLDP1tbEmScHGX+HegtZik1yE3zFrbftYwG6SnXmcuBS37P+JCvoUxIvWMTNkC+hkHTm74DhLGHkSAvyxNy3qP/PjT+G2jL5Ty/WF4AaSTISyBfkc5qAnh+UmBeVSOEitrHRlcF1zqer4aMBBksD5m7AGmYeZW7ThR/w+Ys0pzeIgKYxduyDtwefu3otp8gfM4R1xlfQerm+KjwCsBGYVKKgpgoqiiDQK5Sp5kHgktjT1lsD3hs8ytcYSXID6Qwnwe+R8nB285iupou9itrIL1zSuHIbXDNLqzG8iGgfqE2zO4DIlR46kbdLfGPUd3V/LISBGcUebXwN9D0sxeMjRaCfFHulmeAIQymP/wcsO7LXzbAxG8nn5ixDFJHpB5ObwG6bN0h5VsQS8Vosfo+DTjiiANwg5tEwfFjJ46cKQdHTEedTlaC8Fcu3bhcAT5nZvPJgeBe072hW0coKAN2+cdBQ8cG0XXD4ML0izMvzQXMjKAzoEP3j17cNu/XKWKn8g1Eb4youHk45OtU5MYL7cC3UKB/g3SQ7lI1G7lfgLjF6aa1tFdvgUsZT6cQE7iF+ewpGwuxbpGrdkaBsFMCdXUBRSg6PWSMTHG4URnO7d2XMaY/pLskrbr6MgQVLfdKd3vQr7SLcc0GOsp8qiDneD3bwrgV5GXzFHAMdR5YoBaENq9dZORvoNukx84At9TL6sYXQF6UB+VUEKVEbfEJWmqw5xRNg3seEUAq8TIcZGfpL93AO9r/o1pNoMywuuHjvgXXDp4vhHQBGST3mTvxZzfu+wk2m6nvU7FBGQ/q5+aFWSvhqs/p1l+1hTOhu74ZXg9Sd8dfDo8Hcc5iIhRFhcVZwTY3Z4cDnuAd7t+rZgAYVjjc9iyIJe4ttxezAQfhCdziEuvh1oxL3denQKpdQp1L20BsETpdBR5bPJTcJH9Tj0OJn0rEh0SCVwOvaM9MkNVkbdkE0venZ6Z/Ar+89MvqreMh1Sf15bQY0HfSN9cVAjFcfCTeAzLJepBs+bp6uiqKHxg+NQzQV4Swz86+fn4iXJkfUfNaAihXlXPKb6B8qyxWJkGpGqWGFH8VDEZDpGEpyLPynLzwqDcNornoI66D6bPsfSkT4frecz7ffQymmsZf0qYDNWktfsyljjPslsNBP1B/1KkH+Cwq+H7tt4FDIkDpCWSTTix3TZBinchSAsA0y1gpfSFcaXvywgIJ55bvyz92G2Smp+2IXgnisAjQ9bL2MrcPF5vTVGOZad4Ddkscm/g4Q8naNdp+fA78p4aUbNMNxIuipzgL8qzcK0djsVRoGt1zhybgnicEkEEqN0G+Kt3VNPA2+X9e8xMIXV3n908bgXO4e+Ui10GWkmfMH1pL5eZlZjMRrRC3lDQwfpc5PvEkXNhyqO80Hwh/8ejcWXvBeDLrt8SXQZxQiumG8WfTpgR5Ru6WI0D3oeGi8yfgVdS/Z/U4EKNZr4zj7krSOfKJWCs+gcyvUl+I+gpuuV/23TgMmI9l5W9bZotHxeq2T2lCKQH5O+W747cZ9Hp9kn4biLVitfgWUq6mFE49AtF7YirHvA3KBuUnZS6Q9WACLUfe5R16g3GbMcwUAOmz0/ektwIxRUwUo0G+JbvLfuDzgvdtr1iw/9ZuvF05YBFLWPYY7t/2oXNYBCi9IKHarfyHCkNCt9tbj34PYo/wUtqStxv+BQ4xFTzP5JtZORPs3nAY41EP5Fo5W3r94TqbibST+ER4gHxbllTLQFTPS8XXvQdnWu9896MVkHotwSG8OYhwUVk3DzDkkcRajwFnoLMsoLqCYanDDU8vKOFXbfMHb4H/wBDZxhFECVFdfAjysjXlmeaM8lyhPcrnBSNZJIJsoCabN4PXnvxXq52A0Hy140cPB+c6bq8WVkGWlefNo8k7B6HtxbNLeOhaQtb5dNOdV+Fc4P7d48rCdZeznt82BbWleYnxPIjhYpXyATkLqo9orPYCx+9dgvzrgIufR1zIYpB9KK1Wtl6TS7iBGM16ZQzEjrn5y94MSKuVFBPxJoiV3Fay7l33yFgFnJggxomRYHfA7ifDW0AzmtIEqEA5yoC5pvlFtT+YypjqmwcDdalNzcfyJG3LzxjQA9FEc/tev1jFGtaD4zmHnxxrgK6dvrEuH3CEo5x4LO1bHkUd0V5sAtOV7OopwyFavdJjc3NQ31Z3mUIALwqIarncRB9ZWq0MTkXdKxT+GZwT3FsXKQj0kiXVsve9a0u8XkmLwBH9xBzRAOLSbr6+rwOcbr1r0EffQWLTGPOJHiC2CyddPcAJNxF0t46/YxN0vWQJNRQM9R06ekRBiVXVig8tCgVMRbNb/ABc4iizQUbJS3IdmqB7TtAe4X8d65e0LK+GmyeAR0y+ZhWqQKiu9olRtcH5F3cZNAhkGXnePIq7cUU5YjMdHRdFdO9B+q4Ujxs6OLt979nROrgVcDlk40IsAjUFRF3RXvxKnpkq5EzZQ64Gl1FenxQ/B3bRjo29rmFZsToyl/4Uo5LoD2Zn06UMF7jz/rWzO34HdZB6wtgE8BIFRPXHPJ4SyE8+/IBTHBO7sXhV6oCLhHMZlGq60oob6BvrKuscgBOc4sxjbD8ffvgCfehFN+69vAtTiEAwTTMvMh2ymFLlccAHb7z+cav364dlTmqk+FkZCfE+t2IObYWMOqm/3hwCjBe/ijm5lN/LatkG9AUNu1yGglsHH88y/bA4Ly0EcrIc2D5UrBlmxAWlnG4GJN2OiTjVAk6H7KzyUQmIaxV1en83EKtEsuIEuFpXd8g5zMAi6HrK4moJMKx2SPGsAiVaVtd9qIN8SlD1F34GFvG+PAkkcUeetpbV4uj+s2gC7r+KLaWWNbDVda1P6dBhEFq3dvDoOHDx8rwVMgtkGXnO/Al5a2w2TemsKKObBGlXkvpfaQFhVXb/PPwNiLl2zX67AJrSgzAQRUQ50Z28TVW2L/P3xNdKJ3Cr5TWupCsoF5R5hvlAArfkkZyLi5nioLIBMuannIucCEkLYs+H9QKxVEQqMQ/Q/sNic67ZzwEOg3pZvaXqgXgSSAQ2sVluA31NfYg+Huxq2xUyHAH5rVwhf3y0pgFL+IAEAilIANBGtKYFd8MKxEsWTTLTMbN81jwwu5j9zQ2AcpSl9GMcB9twfMp6MQ4yb6V9f2sYJA2NqXsyDsQ4sVmZnktBM0ZSQZxRSupGg5uLz0+hn4H4SPE0DMMyR5zXnKHkbtyluKhU0s2FtHmJ9pffg7Dw3fNHdoDY9jc+3PMuMF+EiaOAG76ijLV07qZLf9UV7Dc79vHtCCWL1Cz38STwfj3At/Y8kLXVOHUVlrnn1Mc/rhpPBk3A/dew/oHKF2S2+QA47Xf7udAiKHW6Zsnhy8DtvHe30FiQxeVxcz8ezNQiQZwTZXVTITUrodSl2XBm0u5iI16DuNI3l+5PB2GNUxK+orBoxAObBGWMvC5/A8Wk7LdTwPlNjzvB7wKlRC0xEshrDnCgWChaQ7Jd3Dtnf4DsbzP8Y3eA6Ck+ExX/pTEWIM9xnosgB8uP1GlACqmkgjwuT3AKdGeVg8oy0FfQB+hvALvZy/7H0LYZFTNQjnKUBvEh74uBWEzGZqC8KEdpMF4yphlrgppPDVJrAYUIpOC/MBZeIkDUBNXf/Hp2I0h4/3bYsWsgM9UZ5muAPU7CN+dxZKv8SlYA55Lui4MPgD7O7hOX6yD3ylW0eoh+SMu4iAilhm4ppJPM9V8g7L29A0YFQZzfjaA960EsEZdFBBaNruTdsn/n3t+R0XwIHKs7jyoQAaW61Bj9cU1wf9lvQLnXQFZSI8wzePKrYWg8FjQB91/B5h3WX1ZQ64HdPMdaPmlQIrtG5kc+4Fk7f+Eq5UHml1tViwBS89CsLBrbaVFS9ymkjE4YdTEYzizf03LEGkhYf+vAkcUgTlu+wHHBQxS7W/LB2cca2oLua4O3UzY41HGZWCAR2Ci/kLm9kPUYcAHZTEo1DJJ1sf3DloF8U91kdAfcrUmS/w0kiDKUphSIH8UyZTrgZo1bqyqqUAnMGarBXBaMbU19TSuBJjSi/mNo2wVnnEEapKP0A9NW03GTA+BsyajCRRnOZdC/oq+j14EYLT5S3gaiiSHmXxoNCaIs9cVESK0U732hJpiaGg+lbgWq0IwluRSeQ1+5BRwGOvfONxrsTA5veRUGvuZjefkf9MaWweaUUlw3AjIGJS+OdIKwM3vTRjeF2Ik3t++zs5ounbHM0RW+91z/hu3vqqKMME8Hl2TPX4uVh1JFas4ZOQOcL3lUKXIDZA31lvkb7mmAGv8JNAH3rGM1LcqVcqxMAl1fwz6ndhBSttKKgbPBb2mhZg3HAkNkbdkByCRVRuVSny2DxWlRQjcSUsMT1PBqECZ2H//kMCQOiQ47dg3EcSVY9x5gjyO2L/R/Elf2G8tlDdDftvvI5RzY9bf/wrMvyLXMkh65lAuguGgL6hrT7iwzpPklbYlIBZlFGrf/xfG2OZm4CSdhApfdLlOdE0H0pTfdgdX8KJZC+oV0p4yZkPpxyi+pnUBsF1vEz4+h/UpUFOXA1MzU1bQEouffdoqpC1SgPGVAtqEdncFzumd9j7fBYapDb3s9MIpPmfQvjssgsVi0h4wraUtudYPsrIyZ8TuA7mKyCM2l3EY5TxYE/SC7aq6DwN7sdNC3NPCNHC6vPkJ/bE5Q1t9pRpfkTyOPwdlTe5NHN4C4kVG+BxIt4SNKBcCAvfDIpT7beofB8qD6Fnh085tU/nMosb/62mHDwL6acwG/cyB7yBC1OE9+/TyNf4Qm4J5VbIGr5+UBORHEbdFU2Q1BbUtf6BoOAa+VeKHdIeAO1/kduM1V+evdkn/H6u4v9gofXXtI803aFJEAYcP3fjyqNiROvZ12rASIE0pR3QdY4tW8rWUfZVXArXKJLAuGDPs0d2fQvWn4xakSsF+ule1zKVeLtvwMpgFGc1ooZL6YVu72PBDtxFDxbyxEak1+LEvL8rI26Efqe+vLQKHAwGkFAaqJqqISKNeVC8rvcOnspbFX3oT4IwnBCd4gioiC4p9k+/8Lwl/4UwBMh03hZj2cIezUOV8wVTA1Mr0P6kJ1qboRCowp4JBvCxSJCGpYaCaY48xGczGQt4nhDjkH6v9TWtBXRILps6y9KeMhe39m87iSIDowTOT2FonkHN+Bkk8XZ9ce7FOctvq6gLzCSbnoMfTLptGdVIrpPoT0s0l7r9WAs0X3vv1pdUhsEJNyohWIC6KCMss2yLnUZyRLJoB8QwaoXuB7rVCtBrUgZGvlAe/WBf0BQ0vn90EukR+oZ8nbaUvjqaIJuGeVNJJkBPANw+VVKKAUVVpug6Bvyq3ucQrEC2K//jxwlC2yNzmnHrIFWC8Q55XTkDkxfcrtN+DcmP2tx3eFhJ9v7T4yC8RJpbhuOBbBZvPGexzL3Vr7p99kqORSD5TqOn+7jcBFDjMtl3JVRXPxDZh/MfVKdwLTm8aYNAlU52Wx4hH6I+5meEknHdSJ6nT1G1B7qgPUMWA3ze4dOz94sV+TwIbToIpflcAK7wKRRMqbkLIwJTxlKqwJWLtk437I6JgxNjMVxCAxUPR5fI9f+UqZJ8bC7sQ9PvtrwPnSF26Hp4Nus+5H3UTwuOH+pfs+6Lm9R/ibq6HwO4XOBdYEDssj8jioQnVWQ0D+Jn+XNi/QR5lDCqYcPUE9aI7KagHZX2V4xv0EVBHNRC4mSlJIkBdBlFVW6meB3e8Orp79sEyiXX1843VX0F1Vauu+g7TJicmXm8LZqfvSxwyGlBLx+gv5QZwRpXRjyN3rVwCx3JR7gR3yW1kb/PuHmNooUMShXL2eTqC8raQZaoE8KNfLTmipv55RNAH3rGE1IcrJsqP8ErwiCzhXKwMhKVW2DYoBfRG7Ay6jgUUMVU9h+YLMzTuyMW+IQ2Aam70ppTdc7Hy45XQVYpNuxO5uCOKEKKp8wKObInNAJhHLaRDeyhhdYxArRLSSDqSRyJWcy4m6tBebwVQ3+9fU+WD+xdgr3QWoQSvxCN6K8oK8KC+BMlH5WOkEr7d57fu2QTA6bOTgDyNgzvhZuyeXgzGpoycMOw8e0e6L3A/DjV03X7j1I0wvOrPJvELwm/OOprt/BKWw4qs8SmB3DiiTlTHKOxB1MqpV9AqYPHvqsVlJEPb52R7nl4C5m/k981Jo7NLwRL3+MN93Xs3pnWDC6LFiRDHovfHtPW+9Cy6lXOJdWoOsImvIRv+8P8JL+IsaIH+XDUzVwaRk90uNAQpQlJa5FLRZDprTS0SA6KdkG14i9+TNj4LNa/eMEqobC8ld7nx65ns4W3HfsDHdIc056fuIk0B/8YXyIjk7YdmOn2aX/BiEg3hPFwSF25W52PUKFEwtEfzqdyA2C6GUBuJklHwcTkYajxVNwD1jyKvytPwKlDq6YPt9UOhg6PpO1cCxmuvNgjeBV6W7mollDiD3FYwFAsRKcUcxwZ0513U7guDWlcsnNkQCodQWo/hzHNljFGx3UTGRBZSlPpO4O7dmW7YlRwIoTluQbdWVxlhQJ6jxxvHk/ULNi+tcJxIUnZKlXIGmPV/wbvQ+dHvzrWmdp0DD8Q1a1I0Dc5yaqXrB+m0bym0uAYNC3rv4UUtYdubb2d93AVOcCVNVEP1EH9H9Xxg36zI4yjRlvDIY9tXc//KhF6HPhP6dhhSDec7zxZJecCUs4uVrThDct8jWoEx4ffVrhnYfQseU15u32wwu3ZxDneaAfEE2k20fvVsyQUZzGOQr0kmNA7LIIPYBCtrhhA/wKh8IyZ8tBf8G1r8PcVApoHsL4pvcCj3UFG7oLpz8sTYwXXZTV2JxQimUx3MwAN8yWsaC/muDt3M2BAWWTeveCBxDXcMK7gH5MU1kv3/xfjT+EZqAe8YQgaKkeA3UeHOB7F/h1vDLq375DbLLZJ6L7wi8J75WOvIgX8ASCXIqneUi8HDwe6/CZ+Bh8uteoR/QR4aqlcgzQPuRsWmYkZxlBRDPLQ6Rt0knjUQuA5sEulIgvhbXlFtAGkmPZNpywAEHYKgcJkdBbM+43fF7IeqDqLRbbSE1LbVc2lFwb+/m4dYe6gyo06JmBegb2yepxyioOrPKjErHgeWs4Ecgllji/4Vxs5oUpbv0kUHgstHlE+dIaPr+C8UajocXCzU50bAqFEwKmOLvDebj5iizO9z6Nbpy9Ci4HnJ9w426YNKZ/czNgYbUp+4j9chi2rWtD1dHvCp+4cG9CrPJIB5Yw3TpBGST+a+Mmw0dBhxBVrd4P7rW8CwYooP87YM9mq8FRoo1ysdAOinyRq41WbyGg6ko+oK8Kd83r4ToERG+mw9a4wM/BD7gW/H2v3g/Gv8ITcA9axgsyYhtThYx667t2z4Erg461XdJN5DfqL6mcKA8jcRn5B2PNlW+oX4FTgXcggvPgdDytVaO3Ayus70pVQBkgPq7uQW5r/f2CAhnPAgGWVKeUoeA/ITm6odYckcG5FxOHmaT7A76eoapjqdBd1mvOP4EnGCbHPCgrd+nP5VEJVEeTOvMu8xxMC1wetM5daDzpK4Le7vDgEnvtvkgEXaM/H3dHgW8fvPs6zEKmtg13FuvHUzoOTZqhDOUulDKs0QMmK+Z76j2PPzCo3kgF8slchnor+kP6adA3/O9r3f/BD549/0aA4tAyWklDxXfADdO3ex+8zR8smN0+YnX4I2gt0r3nQLvF//gwEgDJIQnlEv0ABEo8otH8frLJoM4EB+LH5X3QIlUlhs2kfdCsrYVuU+yQ74H0k/dYq7Dv5cKyxbf9qp0VzPAYYfz+fxDocSFGoc+WgPuk306lbEDZshu6vfkvYqAPc7CD8Q0sUusgNvDr3607QhExJ1at+gsqJirZCeDKCburYCu8cygCbhnEQmikAgVnUF2lH6qHVwbd7btsp8g6tfw6j8PAFqKfiIK8CSfqHSv3N+wCi5ZSV41zwbXsl5DSt6GUr/W1I/oCE613F8pnAWyknrVPJvH7/5cmjpiDJivGJekjwVZxNwt+1UgiHLkZtrbz8+0Bd10Q5bzLtCV07/v9A1wiI28+Qj9ccYJJ6A17egCt6/ebh0zCi53uGK6ugd2vrdr0b4zMPbj8aemvgjn7S/sCz8DapAspTaCIq8V2VwYaD+pXUqrhaC7rDuh/ADyvLwgwx/fsKnfqmvVE1DRUNG/3Fx4vXaHOW1dQO+kz9DvgrSktJD0TTDzs1krvxwIP8z5qdLPy+CS3aX1EdMgZtud4NhaYP7FvNMcAaKEKG6NY/xHyOvyrPwWFHvdWbsiYFfNcZ33MeCE/I1BuRR0xEX4A1XkdXUumIKMc1JfAOxxwu/xjdfdeLaRspk6FAw/2E10KwwhC6ouH3wNfG4VvFznJZBtpKMag8UpJTfBbM2QI26IespaSIi8/d6JqnBx+qGyU2eA8UTWtqSXQLwrFioPYnLXeCpoAu5ZxTZZ3kEME3owTzaWSB8H4T8dLTbbCLFRkZd2B4H4XbgqL2D5A3fOtT5Lzsqy8rw6Crw+LjCsajyUGlur0CebwfGo6ysB34JsJNPNv3M3RdIj01T0EOfBeDHrcGI/MG0x9kv3AWqIVuK7XModlOtkR9B30291qgN2mY6dvLyBX+R8GfRI42oxOVkFndJTeUNpAboCiruSCoZWhlp6AVGptwZHH4ADGw/uOrwSRIpIENdB3pbx0gSVnCoGlJ8EHoc8PnFfDfjhT/HHMF621QiWiq/EF1D7dM0t1deD+zj3Wm4DAWsAevTR2w1vj4YTP5767IwJdBN1H+heAl19XRUlHyitlZeU6iCKiaKiCPdWEP+nnGAbA0GXqS/pCNjFObT0SgV28V2uziteFKA6qO+ZTxlbQFbR9J6x1QBP8lP5wZrOFdsH3BzZV90M+ncMR5zegmKLKjd4NwL8Bxdb0soFWCc/l95AArflMWvZ3MJpTooQ3ceQWidx8uVucH7mgZ7jJ0G6b3Kh61kg1olspSB5C0qNp4om4J51bAGti0S4ch6yhqUNvV0BLgw5uHRSDUj6KjbizFBrRpLR5P0lmUmqjAb5hiyoeoEPBakzG0qeqlli+FJw2OR0NP+bIF+Sqvk0jy7o6vEa28BUzbgubQIY62d3TF4Eoik9xPlcyp1hN8NBpzPUcCoCTqNdWwXuA2kLi4B/JwmuAQMGUFurr6nvQOz52JrxjUC+LfswCGSyzJB24OnpscMjAtzqumW51gVZUAbJx5BZRR6Tx+UpsHPSJ+t/hiJJRdoVWgriYzFMDAYxV8wSUyCjXkafzHDIapH5blYYiCVioZjNPQH+uJnHQHUP2E1zDPU5BfYrndr4hID8gnfkrlzKVaYpC8CcbtqRcRiy1cwv4o6CaEQXceAR+mMTbIvlB2oY6Cbqpzh8B8E/VJjU1wiBB0q1eC0UGMcWMQsI57CcTs6mUdt6h9+LOAXIbJtW//ZvcL7mgdYTJ0LS4ZiNp5JBHFeK6N7jsa07qPHvogm4/wq2L8vjSlHdUEjNl9D2Uiyc27Wv0dh8kFYh6VJEPRCnLF+ed/9g/47FWSCRGHkSGCfbyingd7Xw140bQMmva14b7gT2XZxeztcU5Isy23yYB/HavD8N6Sx2g6lA9uTUcpBlfXHQTgwVuc19pJMiI0G0F5f1DuAa5eVewhPEBmFSgribzPdfI5VU0kC2l6/Lblg0q2yQ8+R8uQTspF2kYQ44FnZMdRwBcrj8RI5/DO1eJ5IboGzTrdFNBddPXBq7LAEucpHLWOa0FOAyl4kArnGdGzz2OcA/IUAuku/Lk+C819036GswnLXb574C2CDnygK5FO1oWect+/3MOgmVIfvNjM2xd4DuYkquGVBywmaK/EIOUH8HXTdde4dqEJxafnLvMCjcuMyerqtAlBLf6MYD+1gj25BzLklbnOhUsUtZDsZumcEJ2XBh+cGbkw5BbPyNW7trgNileCgtAD12PIaAfo0ngybg/ntYUkkdVgJ1fSBxf0zz4xFwvtCB0InVIXNAWs/briDWigzFj5wFne1LNobr8jfgRzlZqpDPEFTrxU1QqlatTSMvgYN0rlygJsi6MsG8hoeeoxP+IkS8Auou8+WsapD2RlLA1f1YTLA2TfP+GodFE4nnljwEboN8qpXeAvpowzCXsyAPyg2yy780upK7yY6VPcpWZTngjhuuwA1uEAXKPGWG8jHoOimtlArAFa48lsBlm6A6xnFOgmwgm8iXuSfY0kgjHcRq8aNYCqwUy1l47/hjx7q+n/jG4sXq0cbv3fJvghKiE3ajgTtclztyKd+POUoDyIhJfenmSDDaZzkmJQDtGCIexnvXakmQ4+Wr6jTQ+etfd3obinpU9O1XDoLWldvXww6UrcoAQz3gF76Uhck504g1MJwBYp7yEpjXG7ulCwj/4qjd7C0QnRjRZnMQ8DIDRAx5z3VrPJNoAu6/ijWVllhLppIP7pSOPLszGs77HwyZWBqyDmS0jC8DLBbhygVy9nazCbooLsn1wHaWyqqQ71KQ8kIdCG1Wu9Jod3B81dUjsDHIQuoec/u7JfPGljT5RWlUD0NK9fiAC81AblQrmvIDDlYnhByQXWVhtQC4HPYcW2wzOO90dy0yA7Aet/bk8WHLRTlPzBHTwLDBMN/QCovAKwM444wTyJ6yt3wXpL8sJEMBV1xxeQzt++GLL6gG1U0tBRlzM3Zl1Ac88cQDi2aZCmIrm1kNYoNYK1YCqaTluiL6Px2OLXKxLAWG6/Zn3Q+CR0S+ryr7A6kkcJHcvHgtHwqx3JR7ILV0vOOFYDA3M1XOPACiiCj/QG71Nq/I7jJYDQJ9JbsI1/UQElglddDbEFS+nHu3j0A5qow3DAFW85m0eLXqsL9PfbawmC6MFr6gjjdNyhwJl6sfbzXvO7hhurDvx+Igj8tt8h0QQaKs6JrrfWo8w2gC7r+M5F6gdisGiniIrntl22YnuPjqofCpV8EYmXU+aQIwSxxRNpO3oLvFZbkRWCSHyJPg26nQzQY/QpledXaNfRdcrnp+XSwdZGn1jPkjIINUou7WkGM/RQv6ihuQ+np80ws/gLF31sxkL+BFuue6UOhaZkp3MEx02Oa5HbzzB2yrGQa44U1JLC+e3EydD4sZMyqwiu/FN2A/0b6PnRdQjapUsp43A6GUogRQlzrU/MPxR6UABcgH6g/qL+oZSB2btiW9DeCNF57ci487zglOA9vkdnYChkdMxfVXbHGKzaRQz4HbD95FSnUH10KeGcXWgWwvPdXc5nr9CBKNQT1tTsnuC0mmO9mnJoAcKKuoTcnb5G1b7/AFaTQfAbuGDru8U6DkK9WdP/SGQm6hPp3tQDQSe/QngfXMkfnIW7C1431hBLWA2sFYFyL2nBq2qCNc2xJW9ZsmIC+oPcxjQFQXlpRwea3KofFMowm4/zq2ZW8KiVLCkhMPBETlv7R17RS4WPBwymd1wfRu1sLk0sB0cUBZQ96CLo6bch/QS5aS5cDbKWBlre+h7HcNYqc0BU+H/BeqfAHyNemtAvKyPCa/IOe5jlnisLIJ0hunvBn5KaTvTV51TQfiC3FS2ZPL/ZkwkgLiHb4UL4HficKTG7mD3T5HX68RIL+T4+Tj1FxsYvoa12UkSKNEunLPCzGDDDJBjBYjxYcg1oifxDIen4lQQUEAkURyE9gpd8t93DNdlqA4xcC8wvyL+bp1PbiaQGEKE/gYxyGJO/IUiKrKGt1K8NsTFPFCCuir20W57gEOkHuy7KFiuegBmSvTN8X8Dslj4wqdKw5ivNhyN+nxX019gru/Sxmg7jA3A6ejrpsLrYbSZesOHrMTAnoUf61dEojZ4qiyHdjN9/IFcjZF2gRbGwaJFJDd1e2mgnA14rRhyTqIsD95blFRUGuZxxuXgWgu+ojraE4kzwmagHtesMXtlBA1xDCQP8hJ0gw3h14YvGoeXLxx+NvP5oKpQlbj5HeAeeKMcpi8nVHSSJSX7y0M6T7Ep2aZ36Fs2wbvTW4ABcKC97SoAmKxuKRcBLlUDpfX+NtcnWgiuoqjYKyb1SF5LiS8dfvXYysBT/JRJY97E5b21cPgOs07I9QOvGv6x9SqCbSRTuYYHl9Wdx06dCDtpBP5ILV32pK06kBXutMPWMF3/ASGXoaWBgM4VHJwtl8CcgSjeBxOJnvZy0HQt9RX10vw/s27p9c7wG72yP0gNouN4keIKxc3MX4UZP6adTmrLjCYd3kcqaJsy8a0k25qKjjX9tgSrAO/twrFNdwGcgkfyLP3nsvfsH1wzRAHlHWQJO6IU3Mgc3vqu7dMwGg2iPH3aS9GXpPbQZZQT5oHgXtlv5fKOUBZn/qBk8dDviKFTU3sgARucxQIY48cQe7OI5lABz4S9qA2VxcaT0JE3OkCSy7BlY0n5PziYP7a/FPmURAdxQjhzL+f2UfjiaIJuOcNW/xcBdFEzAb5iWyuvg83fC7E/PgenN920H6yDxhrZN5O+ATETyJRsSM3QffnL+uS8pR5MDi951ozcCGENq9TdbQPBHtVWNe7POhPGjo6zwTZWGaYd3NPI7RlaGkvPdRsiEu92WFfWzCNNxZJ/wCwLqiZI5c4KmeDbrpujv12KJheMqT9ajCUsK/usQTkKjlV6v/Q33+KbbWBJJJJgYjfIt685g1ZJbOaZS0D7hBLHDi0dShtvx2KFS72XvA8UJNVk5oP1C/UxerPIMPlJXkF0OXg3Whrx+qdqW5St6vHwLTStM2UBoHTAmXAx1CsWtHJRVaBWlNtKDsC7rjjDhFeV9de7wZZMqtI9kgQ7UU70fox/H5smtsu4aFrCf59QrLaGMHhaxcf/yBgpGyuDs2lvBf5RVVQXzV/b0yE2N9vrNz9E6ibzEezfEAUEMVES+65+a+RM6QTCEfhij/4ZRT+vfEEKDu0/rIpP4KnyH+s8qfWhAcG4DYR8lfyXj2jl5ihVAH1hDkh+02IOH9q7qJ5cKXRiS7zDoK5ralexlUQPcU0pTz3BKLGc4Um4J5X/ijo5oBcJIfI4xBVNfyT1ZfgXLP96rg1kJmcHnTnWxDHRRHdYPL+glXQ4QCypTSYI0Bf1y7eNQyKyoqynxlKT6kz/dMwcPrMbV+QzdTUAuRNeVGuBtaJLMUfkmfFHjrzEqT6Jr5y6TaI1SJV8bT2/H5eatYvdVlJXlVngeeNfN9WLgn5NgZXfOkwMFq+rI58gP4/IIqqpIoLcCrotPHsa3Cp+2WXiGugW6B8pvQH3Y+6Jbrh8EaTzuNf+xVe9G2yt2Fp8PvZ9yWfUNB10LXQlQF5Vp6XF+/TQDrpZAAf8j4Dwbeq73GfzVCdalmVi8N7S98d0+9HKNC0wLH8Y0B+JEfIsZDqmdo89RbsCdhb80ArkDVlQ/V1wAmnR8pAYxM45dRwdTy4DfWpV/oQ+M8rerrVJ0AiMZwATGSRnEs9s8QRsQUyvkg5FTkC4ovfEofigQliqzIHkJgxgawvU8y/gr6ZYb5TChROL7Oj21Eok1xvwng/cKnvsSPYA6S/3G5+AcgiXd6x/hJyCdBmnMUEai5tcsjoD5dDTlT9YjBcSTvx2vwoMH9iGpH1Noi3xXTFMqeqCbbnGE3APe/YBF2oqC1Gg4yXURyEWy9dfvuXonB26d6fR/8M6eWTG19vag0Y/5Q/T9bnlALMCVgg31OPgLgqaulWQgFj0cyW30GFQY37zvwe/K4W/qZRQxCfig3KBOCiJeA2u1ZmbMJ4uDPqetSOqyB/YKI0Anrsccvlfq5wUi4AJV63we48BLUrfbFrBDiHeCwI/h1kE5ll3scjpxxTWivNlBoQsz6m0J3GsLDNompLB0F8cMKwxB6gfK5MFR9CiGOxjsHvwYzJ0yLGT4OZaz5jwmLwNnl947kS5G55UF64z2O5IC/KcFDCldPKr9A/uW9KzyGwyH9++dklockrjZ3qTwSljBKs6IHOvEkvWFt6/fJN6+DQqcNnjy0B5W2lk1L7EX4ftoV118gZ0hX0cXajXG5AkVPlknu+DQ7rnPflawVMlB3UWXdL5FQXogldxVG4MyWy0y57yOyRmhwVC7zCYJEGsqx6wfwpOA/yUIouhdCNdQ5/2hGKN6xSYvBpMKxzyPKsD7K+TDJvImcTpA1bJpGV4o5iBKN3ln+SN4TPPrxgxgq4Ou7U+CVLQLU318k2gOgixogCaILt/wRNwP2/YJujKyLKiR5AM3pzBWLOXEvbfgFOu+x0H3YBkoPiPj+bDeKiqKCbDbjjJyqQs5u0bTmRcI7IGSBfkc7mOHA75d0xNBzKXKt/ZtIdKBZbqfk7h8CuvON33r+CzFJnmK9DzOlrqdvOQlb7tMa39wIfihVKbguHWtuTraWD+Ra4HPIcU3QDBHeo4N1Hgq63fo9zm3tzkHm+IHPCDjvsQLQXrURd2Gz3a9ftXjDceeTEcW/AkSlHPz0ZAhk1Mnpn3ALnZc6DHW9AQf+Cn/sHg76ZoYreBPzKVu4XJ+aII44gpdRLT3AoY+9k9xPYH7T/3q4NJL+TvD7lPQjLOrvvvBk+6zxj9NyeML3KzPZflIPMkpkvZ24EMUtMFxP+4W9CAPHyljwMJBNLGAQMLT6oXUnw+7VQv0ZHLJq6eo28kyO/ylBhhuwhmbUSysPtKhE/b060mioTQInTrbc7CwWmFNv58utQoVrjUbN14N++6IcvbwbxgnJAfwEYL19VP+NBMuhYloMKE6G6CZDVLq3h7Z1wbsO+8mPj4Pr+sz8vHwbqBrW8yRNEGzFYpKDNsf2fkeNshbe3n19goNRCGp9fLF/imaRyC2RVNdL8Jbj08epafC6UaFvd5UNv8DlecGsdFfhdrpT1gWP8KvuSt1OHbS7kbfGZUhH4XPZRN0F8s1uVD3eCy3eOR87dCQlForsdvQWlrtSqNmIPFDpaakunhiCd5Hfm/OT+YpVAWeqJSSCnqhmm+RBe4mjfmb3gaoHTr33VDeTX8iN5GURRUVH04+HjmfRWp5Nf5Ba5DdQiainZCLzWeHX2eA9C15a6XWIvFAoM/KygAHNbtat5DGxi8xvbAiF1TuqJtPdB7BK/iQ1/qNdmomxOM16Akj+XSA6JBp+vfOp4l4Gk3knrkkbDjV43Y261h/gF8ckJN7CECehAeAoXofLPvTdtC+tavRV9XAt6190GZXbV/37iZ2Af6bTc9yLwkWys9iE3L0UVIwgX8aG+DNw6fnnr+g1w+srOE8Nag+Mxt18D10KRyWWn9ZgM+d8OLtn8OuibGxY6ZYB8QWabD/JnwZOL8woe+IlyIM6LcsoMSCkZb3ehIJx/5+C8ScUg7vTNUvvigeb0EldABIuKoi95rxqg8Z8mLi4mJjJS/O2Xowk4jT8hy6kXzePA/mPnYflWQLGUSq++cxUCJoYUbdMBxEJdfUM4MEF2UGeQdzyTVXPEmwBRC8RZEapMgKx2Gd/FHoRrbcIcl7lDij7+9IVVUCa0zsAxW8FuhWNr32DgG4ar13Kp3+bOPVAsUFqCqXPW6OQkOLtyX+CYfXBr/eU5G7oCY/hFTAWRXxQRTXnkwF2ZJc3SGcyxaobqBbwpu8m+IE6L42IPKLOUcUoPEF3Fm6IjkE32n9zObYY+EybMYI5RU1V3kNvVPWoYiEVivpgF4hsxXxkHiqtiL7IAb7zx4tFyTkqQ+dWt5kbgluEzPbQllH25fv/JlcB1o9ehEiNAVpIRZsvzzV2TakBHsRNMe7K9U8pC2Jo9XUaeAn1Xu8KudaHI0nKre5wGZ0f3IcH9QX4qW6tjgN9ZIeuQc9zaH59vFlCHV8UmoAjlRHeI+/rmtb3t4ULpQ0unvA0p2+IGnj8F4qDir3QHPPAV5R79OWv8N9AEnMaDobNmjugtS6nlQVdNP8ppCxQaG9qm41tQpHi5vj17gt0Jh2Jei0FWkJfMk/lzVvXcvBhtcx/DxHdKP6CJzFL3QwLRlY+MB32E/Un3HeAa6eVcwo57Jqu8sDkZfCOuK9GQNT3t85ghcLbjvrVjLkPMmms7t/UBujJBBIEoJWqI4fw/LHNiEaXZpBML0k1dZS4KrrW9J5T0hNLN6iwY6w8eo/3Wl08CWUveMX/3ELVbTcoZh1MCbxSGdJmsXl8Hnh3yv1DlU9Dl1yXYv24JOzCnkremZsNmAfhcHFN+A3Wf+XpWQ7h56aJYfQwuG49nfZEEWb+mnYjJAHFKKaEbab1bm0lae3v936AJOI2Hw5bUdo2cIZ1B9BdzRWPwWRB4vl4vCHGpfGVwZXB70XtOyYog+8gyalXgNDvlMPI2YdoyRFgzXvCR+F68C1JRF5lVEO+I+eKfLMRqsiRhFutEpuIPmXvTr93xh4suh6985gG3ll36ZH0FkLVlrPojiLfEBBHMvRfq84LN6zRCnpQLgK4UVv3BfbFveIWXILROra0jroN7tm9Guc4ga8ho81JyDxe5fzsWE/I59jMB2CO8lDbAFNlZLgDOc1BO5t5cbU7YNC03vEVJEOGisvIlZLZIq3r7O7hiPPnW/Ey4uezi2lXBYO5oap6ZBeJzcUzZTt4Lr2o812gCTuOfYXtR3pKX5QagoUxVt4Ozm8dHwR9B0Rcr9uh3FvJPLZL+0ssgzuvmGr4A3pbF1VI8uJOH7ToD9sIdyCZDxj1Cv20v6q/EFeUqmL7OjkjZARGvnGqw2A6uLwsbsdwRTL9kk6IHcVwJ1g0B7HHEh/+uacu2gvZw+aL6Logs0UWXCH79gro1uQbF91e98V4/cO7r9nnQJJA15W3ztzy4Bp5bu/bcm+uymabzwqbRd+IT4QlkkU4MJHC7ytFxcKn3kd2zQiH+5+jdR2YC3vhTE0Rj8aY4hOYNqQHkLOA0L0qN3LGFGeQXRcRLIM4r5XSfQZpP0qYr8RDWbe+ro2Lg/O6DnpNDIXNgKlFOIGJFC91hIIQqYhB5mwJtL8ZHFWw2rEl66S6D1SKgL253wnU2FFtWKXJAHJRZVa/4uBfBdYD34VIrQQ6S1dSWIKfJN9Sv/1LXv7Hu3OPC5lV6UK6Xr4MU6kKzCewvOy7yPQDFelROGlgJynSts2VsF3Bu5fZOUDWQVWSkeR5/1lwf5T5tpse8BJvtw8EZDxEM4pqorfseTBeMFVIHwNX8Z9p/3RVOlvlt0HtlIb7ILeOhCBBNRQ/OgWgoOos9aIJN44F4nOlZNf4fsKVi2iyErgyYw41fZgTB9fNnVy+fCEnhMfNPVoLgahVu9l4Ivr8GBtcPAeWEbqddPpCvSndzOo/vxZoXNicJ68KYIkRU0g2E/PFF6jf7CNy2edcqPQ+uv3LuxxUBcGvBpbc2+EKWd3qHmOZAPzFXNAAxUqxWPgbscMLn7kg8vcewXs6RvkA9S7yY7pDhlrMEn4uBferdgqAfy7R/6xZ4DPHzqdAG6E4LAUi9tDffJG+T4ePG5gw0SCxWXgUuy+NyJyTWisk4ORqunDkZ8eUYuBMcmX/XbyB/VI+bUkHcUD7TrQdc8OSnpz3qGv81NBOlxqNhm4NJJ4UbICupEeYZoG9pp3fVQYFqxVq27AJBTUrv7fozOLt4fBg8BOT3coLMAr5muBrBk33hSmvPFWCBOKucAOmi/mguBMlhcaFh+SCq5cUlPwdDzO7IJjtWQWZa6vbo5UB5GW6eCHwtrik3QViXXcFD5BOV/1T/o4zovfCN3+RyWRPoKYurJQE3vCgBhpYOAzzcwLNF/qpVukKAW/FrbRPBO8V/Qq3uoO9h2OHU2OINqc7AssDtCXJOcfW4sQm0SjQVX4LYL3yVjpD1SsaK2D1wc8iFgatmwPWW5/qtcILMo6kTbpUF9gkfpT2IYFFe9Ob/wQlI4zGgzcFpPBlsKZ/Wyc+lH7CUEfI6OFd2XxMcC4WqlG7a+UMocDR4S4tAsFvvYPJsArKujFfXAgdZLzthmdN5EgLP5uziTYCoCeJ34aq8COoOtb6pCqQ3TTJdHQ+x2Tcyd78Bsf43QvZsh5SXEipdGAHZ9TOTEmaDbG1earwG8hAbZCcQ1WgpVgDBVKAX4C+K0QaL6dQJuC2v8itwjTCWW8t1AZxwoxAoRZQ5+n6gf8uuiGtDcJ7rfjLIDbxqFhhbvTz4+hYa2+A8uO33bh76K+jK6oc4fg2yjoxVVwGH2Cjf4PEloX6QcTQBBSgmXgZxQgQr74PZ2xSdUQxilRu6PUPhaskz/b+aDomnbnc6LiwL6arrQEwS25UFaAJN4x+hCTiNJ42wJmnOJg1kO+mupoMYrRTQTwbPA/lGVQ6Dwl+XvvrGDvCeU7BP7eagH6o/5/TRHzSPk/wu3+fJaXi2OSRr0mCxxOKkQjVasAxMY4yB6e9AxpmUUjdqQEq3hPYXD0Dq+PiJF6tAevuUD65vhqxRaaNjmoLZZNqXEQ5qT3WHsQhgFWTiHQV9O9A101WyjwG7NY5v+DYAx4MuLfzng0uG585i9cD1updjCR04tXf/MKglGEz22e75QQxkoWhlCZRWDwFh7M41u/7jHyeLQPOjsGgMYrfwVFqD2l89aKwCSUfvbDmVDddvng3/9jTEfH+98I43wVwz+5e0GSBOiGLKMMBHBIjaPLhTiobGfchJwGlzcBr/FpbZEuscmFgrMhU3kHPVTeaaED8iKvzADkj64k6B047g82KAsdZYKLi2VJnXosCrY/7mVWNBV04/xCn/H9zYd/OjfIl/z9RmqzeB2/KYNfWY5fhOFNDt09d3OAOu072+L74KXO947yzREfhCLpGrQc2nehq/APWUqXhWDKivqaeMdiB7qK8ZvwN5ivx8CEoNZZN+GIiZSn79VtAV06n2u0Ec1lWze9c6XmsBq4lSFpe/qXOBzXKRWhJkADtIBs4CzSGPRFqP42laBFoIVcRgEPuEr/IaqK+rR407IWlq7O4zH8DNty90+qkA3A64Wm3rD5C9PSMk7jwQIdKVGyBuKg11OwBvzPyMFqum8a+iaXAaTwebO/sBuVZ2AOrKRHU96PvblXftBt7+Ab/VuggB1YoXaNsXvN4q0LbqYtCXMJxwnQNyENXVl4FZ8m31Z8BE9t0s90/H69GisbrjI8oARanEAKAgxWkLWL1Q72Z+uSMj5e/ATcJZC1zhBPOAO1yXv/N0TXUSi8ZsB7zKh0KA2CTQlQJzU3OFjF2Q/HusS9hZiPo5PHRtG4jxudZ6+0LIck5vcicR+EAsFz1BdBdTlFC0VFka/yqaiVLj2cYWb/ebXCqrAY1kuvo76E7ZdXL+HDw7+d2oNB4KOBV1b3kWvF8uaKj1PtjXdAr0uwaiP3NFE5AvSzv1OnCC7fJd8k4S/P+OzTRYnKpiCIjvRIxiAlJJ5BJk186Mi58MCdei7Y8Ug1tlLzfYeAripkSVOJAPjPUzkxM+B0aIVeJDS0IApTHwR51Se4to/MtoJkqNZxtbvF1D0UXsA4RQdE5gzjD+nnEcYsNu7NkdC/EJtzYeSALnsh7vFF0Fvo0KJTaMA7/MQtMbDgaXQp7vhvwC+uOGns4KcIxtvAOypzXw/ATb5UBrezYN6VmOc3s8Y2sRNwagAo3FLBBfijDlKFCP18Q2MB8y/ZD+FaRdT2xwJR7u/HJj/u5jcOf162t+Ow0pyXGbLzQFc5jpVHoa0Enc0AWAuKUM0+mB/sBW62iKP7SrofEU0TQ4jf8GAgUdyGh5RW4BXsdXFYALnqI4GIbaL/MYD+6f+/YpEwI+LxbsXq8XeC0osLxqK3Cq4daqcDLovzH4OqtAQzqLfSAHU0NtAyyRH8gw4DZX5Vb+e04PNk3V6vRBDzFVlAExg4PKemAbX8uKYHrbmJrmC+muyV7Xr0BCanTwkTch9vWbI/Z+DEned/xPHYbsnzNKxV0DvpTvyr3AJoESCqK4qCaGopkcNZ4pNBOlxvOHwBJvlQlyrZwtvYGXpUG9CpwWJZVPwS7JsY2XCVzXeO4uPgA8k/NvrtIGPDzzjarwPTh39Ygt+h7YF3KY6TUelPI6N/vFQEvRT0QBK+U4mQxyPoPkAWCHXC5rA9c4K5dhmftL/Rfv0bZwa0FKiFeB2rQTG0D0EtNFFeAtMVEUBfbIn2QzUM+Zs7M/gKyLmT3jukHamISYy1Ug8UpM3+PBkFAp+qOjAZAyPOHj8HyQrWQsirsAOMhvzZ7ATyJJcQTxhhirBAAG7HC39kV7G2g8o2gmSo3nD4szhA57EK+IwSIV0Auh8wVCSeMTyF6ZMS4uBeKmp+/f5w1xL0YN2ncSdOX0S5ySwWGGc1L+0uAS6tmvWAlwreI1tqQruLTzvBSyCJyc3RYWehfshztG+DQEfZbdTBcHUKrr/O2LWJwvlFBgkFgsXuVeTscEojkGJMs4zgLZZBDHXU0UR+FKQcADX8oBbnhTGhDW+L+5sp/cBrKL9FddQU0xF8mOApOPcWOaO2Q3zCgV2wfSS6ToI6dA6sL4/RePQXKvuLSzlyF1TsLiS7sgs0za8mgfMF83fZ1uAGbKxhQFKoqKIhlEJ+GjeAJuwkUfAHS3ptIyYHd3ZXVNsGn8R9E0OI3/L6ymR3lO7pPjgHG0lZNATpYd1S9AtGGwSAUlXbfDLgn0te1iXU+AXVfHWO+W4NDP6a18Q8DB7FI+f0Wwv+643Pci2C1wrOtjAl2QoZvjx6BXDItcgkE/3hDnvBLEF7qahuPAJjlfBoP6rXlj1lUwVTB+n/o+mFcYW6dfAPM008ysmZB9PLNDXCPIqpk+9s5HkNU6vfbtDZA5LW1mzADI7p9xMNYTjB9lf5/cHNQLZjXrE5DfyOEyAoRtZfSR/CxGgCglaorhPLlMJhoaTxDNRKmh8SBY3fNlnLwh9wLbWUpVYAFD1KPAajlN2oMM5ygzQbzE2+IiMFgsFh1ArBFpiicIo+iqywBxUVTWzQN6iCmiDBDPLQ6BHCgrq01AessN5kpAOXlRHQdymGykvg3Ml4PkfpAbmCsLAIGUohOIlxkgYoA+YpaoCbxEL3EJRD5RWDThyWUu0dB4htAEnIbGv4ktbi2TVKJBpsoEGQ6kk8xVwEgWSdzToOxxwheEMx4UBZyEmyiMZbkeb55cRhINjecAbQ5OQ+PfxJZKzAk3AkH4icKi0QOU87r7P2fyPe2b0NB4vtAE3LOKLWnxAblOvg7Mppdcx5+XmVH4Y9TRPX38j98x4g9X/Pn75s/HRQ7H867Hti/+Us+fj//1epHD8cfd77zby7nf9xvXvNu7V9+D9Tuv9nJ/vg8/7jm3l3v/719vbvU9zPP8e//vX+/DPO+Hqy/v3ytY/v6yscQPbgXxqhgqVP57YSX/J2gC7hlFnpG75Megb2NY7uQIdksd5/k0AlFW1BeTgCyZQRxIM0Zs66tZtpZ9k1UQ3jtvlH+8zpRDuT+ez8jjvO14XtfldD7jvv0w5VrvH+5L/rGevNu9/3W2dkw5tvv3chn3vY+HLf/n4yZ597j8az0ZOYzLwxw3PcD1D3o+l/uRfzx//3pN8q/15NVO7v188Ovzqj/zAa4vRkX6g7mJcWjaJTAmZ8UmrgNc8RYlrH+8z3vigP8Q2hzcM4pMU6eYzoHv1EKlGtWH0JTaW0c5g3AS7+uKAzFc5zcscVgpf9gayZYp9z/O/Y7f73zqPyyf+kD1G2Ve1/3hvDT9rV/GPNv90740/ul4zvdptO3L+5033qf9+7f79/P3O268T7mc6ku9f39l6gO08wD15Hldah7X2cY5h3LyQeux7adZn3tu15sfoL60B2/v7r75L/01/nk8hacYqa8JN53CG63uDJfOHu06+yMQfcRspTZPfiFZDUCbg/vPIa9wkgWge0evc2gP9u85hfh9B8JRKaZLxBJnpVovdgZA4ILlk+XPX5J5m7D+asLLy2R1f1PVvX1bDkIP63HPv9xcjfvWe3/T0L779Ev85d8/l7f/01bgfbe+nPr1x3Z1CF7A8pfxoCbW3PuV83jzl/J/fY65Py/o9Jfe5/Q883qO/KXeP7dnhw4Q2ONhPe5533aK5TAuggE5PGfb9cpfrhfA+Vyu/+u+g3Xf0XrUz3pOse4r1ueqAPq75cVdE7+tfdv+DMARVwIAXwrRAIQ9jhQDkU8466uDYbrdHvelwDUGku8v46rxzKAJuGcUsU3YK7UgqU/srDNTIWzS7gUjOgPviOaiOZBFOncsl94r9McKcvh/znMvOZV9uOvvJxBs14gcSj9YP3K+/kH7lXs/HmycchvXB6v33tUPc/395r5yul7kUEvuz+WeOLEINMUq5O/t63LY1z/AeQVFPGz5vNq/33nlbnt67LEsMOvMvVUcrMs33V149q/HddbEAS+Ld8RuYKu4qWSDKM8r4meQZeRb5vGQ8k5cr/N7gJ30FxeBKezU4gufPTQT5bOKAXvcQS6Qg9XDIGvK2+pyIPuuu7n2xfhgaKNk42mNxIO0++B9ezDB/fBt/fkDQmeNJ7T+HWJLVp1MLGdBjBbrlTEgNgiTUoR7c3gaTwUtDk5DQ0ND47kkJwGnrZSloaGhofFcogk4DQ0NDY3nEk3AaWhoaGg8l2helM8aNu+6dNLJALlL7pb7gFtEc9t6PB3IJvvuitQAevToADvssAcccPjT1h477KzX6YGiFKUIiFKipCiOJRPD/WZcFRQUkDPlbPklyA/kJ3I2yNsyXppAXpPXiATRXXSjC4jeoqt4GUQNUVkEg6ggyosygBnz3bCGx0kiiSSB3C33yP3AUIYxCuRm+SvbQbwm2vMKMJLhDAVRT9QRNQE33HB9DM8pljjiQa6Wa+R6IIooooFkUkgBssgkC1Ct46tDhw5wwB47wBFHHAEnnP60dcQBR8DOep29dVuX2qImiIKiIP65PLcsssgGeUwelyeBO8QSB6SRRhqQQQaZWOK8jNbnY7bWZ3vuf3Tj/+O+wJJ7UwKuuOBs7beT9bgZMKOiWvf/vLX8Dsx/2Df/Zd923mztnwkoSUlCQDQRjUR9/u6Fat2XN+VNbgGnOSPP3mdcJH9d/id3P4O/Xi+t9+2NN14gqooqoiJ3/040ni00AfeskUACiSCchJ3IBEO64YJhKohuvEJLYKVYLhaCaEdbWnH3hSn3sJcDwEIWsxTkZDlVzgImM5XZwHwWyq9B7pX7OAjqr+oqNQ7UNDVNTePeC8rOIgjlODlRfgbqNnWfegMcmjmUdjgP/j8UmJv/Kvju8O3i3Rz0bfXV9C6QtiE9Kr0WRDtH14hZAXE34/zj64H5tPmM+RyIUFHqbqaHh8H6Apet5CuyE6j+ajG1LsgKsrKsB7pRuiG6tmBwNqQY1oKjdNjmoAf9dEMlfUMwuhmTjMUgMy4zLGsOZF/OjjQmg7pbPWa+DKK10kypDsousUUsBfGWeFN04t4LP6duRcob3ATltHJIrAP7UfY97byApXwtfgBxUZwVh0C8LwbTH8iHH37AYXmU4yC/YB6LgSH0lyNB9pJ96Aeyo3xHvg98zEjGgfxMzpBzQUwXU8U4MF0znTYNBfNl8xXzOBDBoogI+kPHUqyC9TpXOA2Gk4bfDBNBvMRLNAFWie/FNyAmivGMBDrwqmgDhFKKEveev+13SCQ3iQJucYtoIJFEmQS8Q3/RC4SrQGSDGqFGqHbABCbL6UAoJUUJoAhFKAwUJZgg7n5YEUIJgkEUFyEUBYpTnGJASUqIECCEYgSD+FLMZTqoA9UPZA8wehg9jO7c/bC5K9giZSQ3QbdCt0D5CHSf6oYqaSCHy5GM496Hgw7dXYGt+8O+7m6YgW1fZz2v3L1eAUpQghAgjovEg+lVU1tTK+AHfuJn7n1AajwTaI/iGUPOkV/IRWDXzq6C3XHofeDtS2/NgQoRFRzKTAB5Q42RlUB8LH4Q3wJ2GDAA9ZnMJpBVZU35Oshu8gsZDdJTBslhIEfLLTIfKJ8p2xQJv87femfHQvj+px/XrNkFygCll9IW1NXqBnUf2Dnaxdotgno96xSvGQmvlG6T1PIolJlWZmqp5uDe3e1l124guovOSjMwVTF9YSwHMaVjWsa6w5T+n707pw78dmJH853r7r0vcsT2RZ5KKmmgdlF7qh+BLCXLyhrg2sTV4NoBihQpMqbQEAhNK1WmhAmKtwoxFf0SCp4I8AqoCN6nvG54BoFDe0cXhxhIT07PTK8OCV8knE9sDdf6XD994xKcPXduzgV/OKOGyXO14Hrn6+VvxEBmZFZyVgDoSigFFUBkilQRxT1NwkZdGsjm4PKWS0GXDBj06sBCfRyhWM+iE4KXgVwpv5OrQPwgGorLIMqLcriCnCc3cAlkEdlMfgjyc1lFpoA8JE/I7iDflDNkGMhEaS9fBeEkqov3IWrMLVN0S5htmFNiwRq4fe32SzEf/V2RkXPlPLkY7L3s0+y/hT6Ve9XotgvK/lQmvNRbID1kU7kYxGLRQQBitfhRvAcU5hVaAS644AJc5goRwCUOcgS4TCYngda8yUbIDjT2Nepg19HdGfsqQZXllX6qYAC3+W5H3AKBnvSWA4F8lKUBkJ8mNABRV7woGgPNaYYzMJFtVABaiZaiIog2VKQD8BHjmAdqd7lIVoRlYnnr7yfAzuu79HszQflcmap8ABgsv3/ZSLZQu0HQD0HZQcCAgv0ce6aD82YnD6e+IGvKujTlniXDWg4DdtatZd/u7nHbvuW8VXAp6Uq68iVsXb0tacen8KPjql/WOoK8LWO4AyJA+FPgab9FNGxoAu4ZQwwVQ8QAyFyWWT2zNZy5eubrs5PgrepvjnjdBdyuuJVzTQIppV724l6gRxB29ALSOGLN6OAsnAEjzjgBu9mFI+gG6t7QVYDLGVcWRlwFuvIjjUGdq85Wl4H7Sfcpbvuh/xt9u/RUoIPu1QGtK4HLRZfCLmtAnakGqF4gq0h7OR3YzpdUAlbQz34nuCa7bnGtCAEr/E0FXgW5kKGMAKbjct8bdsQRB5Bu0lsGgawhi8uKUDA2oLd/JjQp17hog67QpEnj/PV+gOKNQqYWexfcZro1d50C+sv6N/TVgRt8jAvI6bKxrAnM4zZLgFGMIBHEGvGT6A6M5Zy8AMaixtdMH0OsjP00biKcqHHyyzOBsGnFlmHbtsDeTvt+PXgAEmMSWyY5gdJBaaGUAfGmeEO8BhwQe8VWSPZK9k25DOG7L/ldGQYdR76W1C4f6D/U99QPAvmZnCnnAlGEYwQM6OkOwqZRuImKuAJuuOMKuOOGG/AKrUULMM8ybzSvgcmRUwNn1YE7H99pGlsPxFbhI+6z7pt4V7wj+kBmv0x9ZiG4HhbZ7IYj9D7ydkjXHWBoYChh+AZ4j8+YDWSQKbOATcy0CvB7Jsoy1m15LJq0CkoNpa1uMGz7YPu7v3eBXz/emrXjLJRqW3J8cTdo83Hr1OaRoBZU3WUp4BiLmQscZgFmoDYumIE4fucg8BXb+RRYSFHMQBbH5Feg7FJm6xrB9tDfbuxKhlNBp9eHVQOxXHwtOnFPANnuu6NoJxrCjUs3nKJWQebGjFZZn0Mrx5bvNBOg7lX3q6WATLKs8Wr3N03KP/xPWv81gvKDWCYmwY2pUZ63hsGMhrOSv2gLag91m/oeKMuVAkp+cgv313gKaALuWcMee+xBDBfvi26w8/ru7/athvXHNo7bMgw63nmtXLslYF5r3mq+AJjuY0pLtG4v/eGYzZRZRgaqAhLfSmya7AjqTLW7eg1cIl3WOfvCexmDdvX7Gl4T7Re80hfEDbFRXAZTtkmadnNvLugviCBRBH9QV6rTJSDqiSqiOogG6KzLwBzh+z8UsL7gVT+1sFoDXNa6vO9yDNrQekzzFtBp3OvV2tWDoq8F64tMAOWKclJJAvWOmqa+AzK/zC/zgWmu6VvTqfuMY2u6MOoP+zVpSn/r/xNAKaWUVBZCvjr5bvnthGZOL91uHAsNhzaoXudrOBZ4vOqpFfBVxjfbvt0Ku3fu4cDbYM4wG81OIIqIIFEYpB8u+ML6uA1vbG4PTT5sVKi+gLpF68iaF8Eca842F+WPKqxl5vQ6Sdbe3Phb35NB10nXSncOzpU7Ly7+DuvybRCb94I6Sp2oLgAlVCml3M/ka/1gIFnEiyjY0ef3PbsbwZnWYRXPtYQKW8vvLNsHzN+aN5qvW8vczvtnKa6Ly+IUJLgmdk3qBksufh3w7TqInhzd9HYnWBny3cRVMdBoW4OldT8F30DfzT7ZoG5Rd6inH/znr5RWigsJMXXvrImLhi9iv+y5eCDEV47/LGEc6My6LF3sffo3UYwTn0DG9xkbMk7BYoevri33gqpjqhaqeAoCFxX0DlgIalu1kzrowfuDBx64g3JYqawUhVXNV4etLwFhnE2/EArigjipAPhTgPwPUa/GE0GbFn1GEd3FW6IzGKcZVxjj4efWa4/8EgWJfondkyqDuCLCxfGHqNBqmpGVZVUagPGM8ayxMMiisgSVoI1Hq1kthsCrprb9WvmDWCm+FYtAmqUi3clRsN3rsHXriafwBOV90V90BwoSQMAfrrMJtttqiuoOAVf83yhggjG7Rrcf9j18PP/DdoO9IeREsaCidbA402SDOcNsMJcF6Sa9ZGEghhhrqrJ/hDwnz8uLoC5Ul6obwPStaaP5GhgMhjjDD1BzRo3hVSfAtF2Ti4/JgP5xfeN6DASnek5ujhNB3anuV8+BMItMcQeS0pPqJ+thzZCfszaEQlbT7N7ZO0C8LjqItv/g+RcW/sIZwl4PK3muN8SVi5uUMAqU9korpS73nDZyQHEW9iILEvon/Jo4B06tOj0l7A6IJBErrj7MQFk0GV0dpZLiAyeqnih0+ms4efPUvjOVwHDEsNHwAVyqcDk8Yj2cnHyqT9hhUBwUVUQ+/H0r9ZXKunxwrP+xLifT4YwuLOxcflC+VKYp/bA4x2Tcp6D1d6LUUMrqPODSr5f7XGkCW9tt+/r3qiDuiChxkdxTpN3vOcSL2+IyJFRJGJ/YHX4ruKPLriMgP5ET1PkgCooA/B/+PjWeDJqAe1YxYcIESpaSqIRBRP8Il2t74eYHUWm32oLytfKlMvYh6rN648kvLHN85gSz0VwMCvYMuFbgI+gypdOZ9kFgt8/uR7s3QTaUTWRrHnzS3OZ954cf3sAJcVjsxuJl58JdAanWVV9Q34ACXfJfzzcXxrw4+txHIfDyxBYFmoaC7pbugm4DmH8ybzKHgbwsr8ir/Pteatb7lJ/LuXIhmCPNKeaC4OrsesS1CPQe9vbkbjVgwA/9lr7tAg6/Osx1KA+ynmwkW4JyXTmv/A6Hlx1dcqI1RO6LbHvzNIhtYqNY/PDdkaPlGDkJ4r6MT0y4btVcPbHMkTk/QAXWcZctZDvZD5KmJp1ImfEH56MHHU9ni4lbnSA/k1/DoaDDRY5FQfrt9AIZS0Bcs2h2WduzIrLqwfm3LgSGlwA5TA5nzD94DtbfadT5qA63VoOxtbG/cSOIDsLiDJMHIsAicMyNzG3M78Pxr09MPK2HbP/satnjQNQRtUX1B++O8pbSSXkJYtzufBA7D6ICoubdigWxQJmtfEKeHxoaTxdNwD3rDGMogyBLzQrKGgHJo5P3pYwHsYB5zHiIemxzFt+ygh/BvN8UZnaA+pPrd6ydD4JHBYcH+YB6WA1Tk7k3uf6g2NzVffDGA0RrWomXuGcafV12lj3BMdnxgENbGDj6nUG9d0LdZXVG1HwF1FRVlQVAjpXj5TT+NsfyxHHEAQdQt6m71FOgi9VdUTbBGy06z+5wGtpOaEOLEyD7yQHyfRC1RBVRFGI/iD0fFwVhIWeTzhcHZYDyttKOvJzR/4YYK8aI4eDR3b2AeytQFitzxWj+Hh6SE1aNhmMcEr+Dw3KHUfb+IHqJt0VXHvjFbJvTy3DJqJ65Cs7OPdflwkiQJ+RJTt+rR8bKZAkk90lelfwO0Ea2k10efthlskyXekj8NOlQ8hcgQ2VZWZOcwyH+iu2+RoqPxfuQ1CZpUVI/ML1tGmHaDNSnHrUfokNd6ER7yG6W/Xb2z2DsZBpsWm31Yn754e9P48miCbhnHatJT77AS/IVMPczf2D+EvASXn9bhiYXhF5YNBRn6SbzgeF1uwL6jlCvc50yNWNB/41+hr4byIsyXF7+B/20vYCccMYBuMo1GcFdd3v1qhqj2kHDnxsMresLLU43e+fFOSCXyu/kryD3yf3yEPfirR4WB+vcZWFRSAT+IU7MFgf4T7F56flJf1kC7I/br7ZrD93eeWth5y8huE2RtYWzQbaWr8uBkL05+5QxP5zOOnPybBFQV6mbzWcBJ+vc2INyilPyDPjP9PfIvx7s99ovt2sB8lu5Uv74AI/jsDwij4NdqJ2n/igEVApYW6AFD64BWhGBIr9whITFCYkJYRBZ7Mbqm6GgdFM6i2Z/uNAWj1hd1uYFkOnWOLuHRK6Q38mfwHjDaDY2ADaxhW3/4LlZP1DkKXlO3gK5XK7gBx7+w8nq1St2iK1iLYiVLBMLscQTpv+Dfmk8UTQB96xjnWsSE8QopT8YFhkm6JuBvCQvE/EQ9Vg1KbWm2kR9DTKLZ1RNDYV8Ffxa+aSCLCbLyxb8c1Pgn4NhkSMYzacgG8gmshW4XnRZ7JIK7Ye3u9V6Bjj1darjsBPki7KFfPUh2s0iiywQKSJeXAd9aX1BXTIoe5RtynKQ7eRrsivIBXIh34AyVBmodAGdi07VnQVdbV0FxRtEoChIAA9uYrKaWM1R5gTVGQobCg0KPA8vznihbqPFIA/JQxwFUVFUoCycb3ve52IZSPsg7buMyiBmiGli/IMPp/qDulbuhsDigYsCCoLHCo8OHsNBJso0+QDLssgQSlEFXC+5LnCNhKDbhdsU+glkmsySDyHwxUfiPfEmRNa7cSCqEcQ1jfs2/nsQjUQdUfoPF/rhiw8IvZAiGYQLzg8jSO+2lw8/fEG0Ei+J6lgsAl4PXw/Z1gD2WKLFJeAF0YSGWEz/5oeoJ8oS/6d8Jb4UY0H0VXqINkC0NfGCxjONJuCedeKIJwGU2qKqKA76LbqV+g+ASCK5+RD1CIQQVg3OFxwPOkx22AtuYW7fuvqALCFLyyog6ot6ohYoF5WTymbQN9FX0TmC/kN9L30N0F3SHdN9B8pI5QOlB4hKoqIoh2W5EBMIF1xxAEbIcXIoqJfUKFWB4u2KLyq2DMqayoSEhoH5W/PP6nHuxSXlhTWDizJTmawMheTSyUOSq8EvczalbNsCk4dN3TjrIgwf/Un2+EMw8pdRoRNiYGzJ8Z9Mi4aFuxavWHoRzhrP7rkQB3KVXMN6EDVEdVGFBzeBJZFMMihDxUDRGWr3r/VqtXbg8oPLEKeLIByEItLgWva1GZEl4HZUzKsx40G8J/qL1x/8cckN8ld5GHwn+hTz9oMAXcCYAoVATpWz5YoHKD9D/UL9HvK75V+Uryvk35qvmZ8nqLPUL9UH0ABt4yHKi3KUgfObzn94cQqkrU+7kdEfxBQxUYz+w/XFLIHZylrle/E54CP+mWBqJl4SL4ChiqGwPhqoSx1q/oN6rHPYYqn4ii9AVKAcZbiXOeVBsSVecLYkXhDR4oY4BySRRPI/6JfGE0ULE3jWsWXUqC1qUQ3oLN4VvQAjRSn1EPUYMcpsYC3rWAsh3iG1QtzAs7NnM083EIvFXNEHTO1NvU1fw80Xbl6+9SHc6HezT9R5ME03LTNVA9co12EuhaBApfxb8p8Av/x+l3xqge6q7rwuDGR+6SxdQLajLa+CbCeXURhKO5euVrItuJV0PevyPqhjZaa0w5J5IzWXfls1LGWFskSZDDeW3gi9+RWMLTlhwbSTsLfzXtPB6pC5NKtj1pvAXA5zDCjM7+iBY/9r7zwDo6i+Pvzc2U0hgSQQEgLpoVfpTRAVEAEpUhRRERQbWFARUJSmrxWRXqUKFkBEQEBARAUBQZCSEDokhBJIA9J3574fdibBErIbwQT/9/nAMLuTO3fKzm/Oueeew3kiQPQVb2tDoNLYSq2DXoSRi0c893Io3PNq+xfuehikm3STbuQ9GAvEiMLTB8rn5FgI6xVWIdQXAvqVr1p+FVyNuXoozhuSApNzUgLg2EPHJp98DKo8WfmxqCzQJ+kLdSeiX82xPa9Qr2+91kLUL5Grw5+FXU/vGrQnBxjHS6y5zt/r0iL9IMwS+nLIeSg9tUyf0quBGlRkEbDDmMBd0GHWdGSeyX069wXbWxCdEENsP9AX6Mvtu0Dz0rys95AfXFSGMpQGPhULxEygFh70NhrLceE+bU977gTrJutP1m+BlrSgF/A9K11oJd8y78H9ogswlQ1MJz9lmrOYv7/6op6oA9SkDa8CX3GA/S60oygWlMCVdMyw5hQjNdEe9sh9QGeqsNr5ZmS6TCcDxELxmSgNdY7WWV1nLHiHeMd6V4V4Ef9BggXm+s5vtng5bHH/cd3W1pD0QnKbFBvIifog/XFwT3T3c/8B/B8q37bcXGgR22x4k/fgkYyHP39gIlRdXsUz6iPQ79Q/1bNBS7EEaC9CRHT4kLBloPW2dLTMB/2ybaFtD4WGbYsqorKIAr2X3kfvD4suLtmy9CX4ftDm13/qCZbnLSss2WB9yTrCer0UW2tZjAUSmid0OjsN5oTOvbJoOTRu13hm/XFQ1tNvoF8iyKvS5owLTzaSTeVdUPrO0nu9G4K/j//qsoPgZKdT35xeCjmBOQE5P8GB1dGbY36Ae5Lb77jrFPkWa7YRBFIQRu5I62jrC5a7oOqQKm0rdwCtpXabtob8FwNTWP50v4jl4guxAKImRiaE/Qrut7u1dbsP7Nvt8+y7nLhhjhLDLrjc6/LiK6PhqP+xz05cAqELb9EJ/iITRu5U3pGOVF25POpUMMyfqUcdaoM2W5ug9QR8qVZAioDro0sdHURvcSf3AUHUJxCQpLokcPnBU+UpB5SjLH7k56RUlGiUi7KkYwqA6RI5wEFicD0Ywxgs1+xatnYcIiZGdAlbCmdXnm12bjqMeGtk6XEaLP7ms8FLa0LCPWd/OVcVsrdln8vuADk/5x7NjYCrddOfTAdONT8VHfcWLGn7ecayBTA0dfjHo36E2KdjaxxtB0xhMotBEyJTOwp+0b7v+3wH9OUheuH8fKSzxBENqXVSR6TdCztX7dywezIIf+EjADFCDBNDKDR3pLk/S6DFw3ISjoed2HZyIpwccbLi6f2gndRitM0unM/3+JBJ4BnikesxF3wr+x71KQ+yl+wj+4OcK+ezGKJ3RM+M/R0y92fKrOEgXhJDxLNOtG8+WI2xpMoeUf0jJoNnsucOz/4g58uFf+eqlDHykDwM1pnWcdb2ELU+yj+yE4iqIkL4OX/etanaeG04JESdXXTOCglLz9Y4Ny7fRfwXzPlpHzOJGUa/bYXv5y9UpzpVQLtTa6oFAZFEiLAitGNacL3oSTegIkFUIC8ji9OY1yGAAALIS7LstEtbUawogSvpmA+ky38SODPLu7OYYyrbxE9iPeiL9O/0AzAzZLbPgoGwc9Sv7+5+HLQV2iJtNGhbtPXaQhAviOfEUyC6ii6iI4i1YrVYCpq3JrRzYH3VOtDaDKLHRHc/NB5mx879blEWZPTNfDszALQd2hbxOViruZWzHgOOcBQXojSFXWSLS5Bmvdz5cllI6pL8ecpcEHeI5qIGrj9oRvEGQyF7efbenNsgOSO5S0pLEAvEXDHVhXaMagEiVVwUJ8GyQ9tgmQakkcpl0GZqk8QbcHLyyQanEyGx7cWlF3eC6Cf6iHuc342+Ul8rt0PouJDs4HFQ9hm/Sr53g7xiuHj/THd68giU/qz0i97REDErXIQOABnlSIHm9HlPcRzXkTePNjgeBlcaXXn1am1gH7/x09/8gVm9wBjbNMdkXUUYSZm1LC1ZOwiYwUCuYlYneJDe4n7yM43oLlpe5vaBBFIe8McRveyqq1NRLCiBu1VIk5cdAifzBa4I4fTaHVojLRAOvhF9X+x7sDF3U/st+0Ds13Zq3zhRPsfE/N6YCKy9rD2ttYedVXbW3R0Ex84fm3+iG2gdtNZaCGhp4ry2h/ws8E4iaota1AB7b/vj+tugd7M/rI8G6lJbuDIGaWKG/XeSXeSDkNs7d7DtC/6aTLnQjhlLcxrCIPEsA8mLBhV3ipaiFlyqlPR68mg44X1i9alRoI3TXteedn438ke5XcaC/3T/FuWaQ8W5FaOCfgc5Wy6Qq/66vb5W3yR/g4B55Vv514Wg8ArLAl8A+Yn8VK51YofG9bQPto+wz4KYVjGesbdD7qzcr23nQVQX1USVv/k7s+zOdrbLXeQLjKuEOARNW6LN1d4FEUQQgUVoxyi7I3oJR9WNIIKEacG56qLUgQrKgrsVUQJX0rnWRXkF5AEOcgjXXZTmD9LI2LGz/6+DdneAlPWp7mnHQSsnyghJkX+4WhOtnlYFkjYn35a8Fg69HfvJ4WdAa6jV0iKBZEc0qMsYYx2iAfWpB/ob8m19JuiXdbteAfRc3aqHX7PMKWSZrktZCfTh+mh9CmjntBPaNvJzOLp2bSCVFNKAqXI6c8irHyYeEg+KHpBVO6t71no42D+6waEXQYbKSFkXJ8orGDzFM3IIeM/3Hux1EiIbRE4JPwnyQfmwfOJvTtdW+at+FEJ7h+4I6QC+1X1P+lYAWUr6SCdSSompYpL4ADLqZQzISIXYlMNfH90Moqu4j3uvc3+Y9f6OcZwT5I2BuUwFAkUAiI6irWiEw2IqSjSmMH4fpsfDLCPk6ouhebyBjukLlKc8/jjuS5XBpMSjgkxKOvkC57DgDho/2Ia0cCmnXmVRWUSC7WXba7YJcHzkichTh0FOkbP15YAFi/Y8RX8zNec9RVKdGmCba5tvWwTWE9Z3rdvIL9jq4gNGfi6/5Ctw2+Pezy0QwgeENQtpAz5XyywpkwqionhDnAM0o11RwNJsL5Jxch9Y21uaWjLAp7NPVpnSIAfJ4XIUOB1CbrQqU2UaaSA38jILge0EXTvGKCvL6rIhHOwQ7RU7BLKWZqVlfQvuj7g/7P4AyIVykfz8Osd/Vp7jPFhbWetYxkHVEVUio+4CzVsrp20nP1jFLPPSQbQXd0HlxpXdIzXwOOBxzv1D0FfqK/UHgUyyrjcBWwwST4j74UJm4rSLmRA3IW7KmTAQ04SP6A88zQC6/l1HDUsn1eGiLTJ++OID4ryIF4fID6K56mLmUSsWrCD7yyfkYGAf+2UbwAON4S60Y7ooK1CBABCmBeelLLhbASVwJR3zQWkGmbzDQXkIaExLvnWhnZY0pwnY9tvO2kLg8sy02ZcbA0uJF22AFXzyj7Khm8JYzhijuIPWtAIWMwVvoBpVqQLsR3LUhWb7yafkSKj4RdAPFc7AtC2T9384D/RQvZq+A4ggnFAcb+yOwpSmsJkVqE13ouPfiXQnF1gtnhT9wSe+zMIyiaD30O/TNwLLWM43Tl8byDIqdu/ld+kIG+/A6fxNtHHaSO1pOP7tiaiTE+BSQNKy5Gch+O5Kz1es7cT7hCnQVagioiAqLrJV+ALwqO+R4DEScpbnLM/5BmhFK9EC3OpZb7NaoeqKKjWjHgJtg7ZKmwN6Xb2p3pVCXzC0/tpD2j1w4usT1U/NheRnUlamzgQRLIb+IXNJQefDYlSWLyqejgrnYhxjeA3wZBsfFKEdM3PPQBnDi0APXmMJ0JyyRRm7pkKeBecvygHpSIpSwFfxr6IErqRjPpBMF0sMsRwm/wHuLEbFbtlRduFBsD+lL9fHA350wPcm9Ntw1eFDGcoA1UQ1KgP76ObKm6/cKX+Vv4G1mbWpNRTKi/I2/2QglXDCgH1/4yoqrH0BLHdYPrKSfETWNFJgfVqE4zQtqGhiOAxUpsO1rk7xmOgjOsDFFhcHX9oCJ3ac5PQ3ENokZGqlWNAf0592xtUlY+Vx/RIE/xzco9Jj4LPeZ0+ZqnCx4sWwS7VAPCAeYgB4P+Fdx7sXRKZEdAvrALKpzJXDKdxyNscmjZyS0etjJh3+GrJ/zN6ePQEsHS33WtpRsGvVdJmbQiCEub/zLp1Ps51KRuHQM9Qp0kCK1RDawbwghwHRnCIWaMkdLgmw7rBMRYAjUwt1DAvuqiF8qvpbiUYJ3K2CmWIoo4g58Mw36x/YIn8GOUZ2ljmAftOSGpsTgH0oDVSnGlVwPfu6max5t/xN7i2BY/tmUuMj8gjHgChmcE0KK/GKeEkMgsycTJxB6asAACPeSURBVK+scIgeHN3w0Otwx/RWT7eYh+OAHqNQAdK367/J41D+S//McvdB4McB0eWXQeLziT9e3A9yNd+xCwJuLz/FfwJU7FZxblBPkCNljjwI3EFnhhTcvugteolukDUi65Ns4NCQQ7UP9wU5UZaSnYBZjL+uMJhVJ2pTixo4hKoo8+AMi1i+I99jAvAgc8kuQjvmffOSHCpHgpws2/IkMIlnXRRMx+3mhhtW8oXT5fTZiuJABZncKpi5Gt0LqctW8N87HqAJJHAOWMwSlgEalptyF5hKZFhwwhS4EqdQRcYhR2b04DFOGLlB/3h0ZpmgT/Uv9Y1w4ImDzQ+9BdmW7Ko5Y0F0EveKdk7s7U7a0RVKW0r/6l0HQuqFfFapEUhPWVoGgTSqHoTtCm0Vshr8vvV91mcOSKSbdCJIQ9QV1UUQJA9O3pq8Hk50PHnx9GegDdGe1R5won9mEuO7xV2iNc4H0fwZIzVWXlDMZS5zpQjtmII7gtcZC8RymCOAxeVcq47rbEyDuKaag7LdbgGUBXerkC9wbkUSOBPzh++DD2WAm/UmagqZmb0+ijARAUiOF2nswniAinairWiDIwmvP/nBDfKaPf+1Lzf++z48QA8Q94tuXAFymUYuf50fZaxpL2rPaL3h2IPH1p9oDUlPJj+VXA0q3hZUq8JBJ2ZlbJc75C5wr+te2c0dIvZFWMMeAFFLjBGvAZdIIhmqtK7SM6oceLTw6OMB6P30r/VVFDoNQpsqxovhcNoeVy7eBxJbXLxyaQuIQNFHjAE+5H12XKeDxnQJYZSXwcrneU8XV6ZfpJAiU0G6SS+5iXyBc1VOTAvuDTmK/wMOc4QAHL+jKBfaMcZwpWmp1zVeaBS3BErgbgUk1wqcmZzYNWEyo8GCqUQQ0Jde9AIuozPf2OZGWnJmZpEmNKYB0F+Mohcwh3ZMc6EdU5DX8C3fQW6P3GdyPwO5Rf4iY4AgI0OF6UJyw4rbH9bd8tZv5OeNaSjqg72x/YTdE/Txson+NBDEJ383b0u8KJ4VD8CF1MRhid3hVN9T6XHVIDi64idBa0F/rxA7xbAUxWOij3YfRK2KXBlxBSw/WFZYloL4ULwnxkLVt6umVdZAm6J9pn0M+st6Tf2u67RrKqsxofrQhtg5R+dCRnxGtYxtoPXXOmhNKbzskFHWidcZwcvAUJbnWXCuCVwqqSC9pI8MJl/gfF17rRNGPUO5WYbIGsBs5ssVQF2svOdKSwam5WZa7PnBS4oSjBK4ko9DyK4VODf+bFUUjjn2VZOaVAcxXrwv+gGPMyEvNP5G3g1G1KewCLtIA0ucdtCyAjhPHxKdb0ZMEB+KtyGjckaPzAPw8cZJP0yfCiefP9U4LgE0oWVqP+KI3ixHfqYJf/wpm/+5MNfNeVX+wp9Sf9xelLvm7/K2M4IKvI2luS64QjeQ3WSErAMx82ISY5uDZaQl0lIH8PtjsRgxVowWIyDj+YyhmQKiw2P2x0ZCy29bnGoaBwjKE0qhppzsIXvLfhDmF/poyBrwalWqQqm5oH1naakthqgnIt8Ofw5kb/mKbOzE+a0r6ohakFsht7KtBcS0jHGPfQX01/SjehZopbRSmgcU6lguQ2nKgJgrZouJOOrzjTC+y3ThvjHrypWR5WQYSCNjDKH4u3T/GTk/5SWZJiXIFaxkDfAWvV26z82RUdOCUy7KWwolcCUd87HyVwvONezo2IHbqCfqgOhHT3YA/bhIHWObf1IY9M8kcJbzoG3SvtFmg9vtbtWtsUAMh6Q5HeFq4c2ID3iPMZDVNOvjrHdh+54dx3bthkNfxvodaQ3aIO1Ry8hrztMlY3kx75HsCGlZbcyjkiQan2/703nOf4QnGeuX/qZDEiklcNrYPhkvURosuyy1tXAQ4aKi8MIxb/Fam8zLEf6u19Ib6Z3hQPDB72NyIedYTnZOJ7A+bW1lrQXyJ/mz/KXg8yFXyrVyB1TcFtQ2cCX4rSj7qG8OeHzmPsmjIVQMCIqq8BHIj+Vg+RDQhb6Mus4JPsMpDkLaoLTNl5fAkTnHJp14C8R8MUjMoHBhMylLWXxB7BY7xPdACKUY4/ptI1OkI9ONn7TRHDgsrxhRvhEuPa2MoCyxRCxkFohh1CcT6IZOjIudEuRHy+YqF+WthBK4WwUzfNq04FzFSF1EXepQE5gpJogJgI0eRUqKWxgJJHAWtN+1HWIluD3rFuD2O3BQRhMOwFVCnWjnYfGQ6A05E3PdcjuALcIWaesG1h3WZdZHQNusLdIq/oN+GvX2ZJJMksnkZ6gwXbqm5WvPW9pJJT9zRxlKkwwCkSvCcQjbdV5AxP2ik9YCjg48yvFDkPJZyq7UryAwMLBsgMWJsbgkRxi/3+ayL/hNgkpjKw4M6g3emd7PeJ8A37a+Q3wagDxsuPgKQZtiJFX2P/vLuSpwbuC5k+frg7ZNG6e94MT5MzscTLCoBKKzaC/6AKdYJnyMbY64cD2MjDfysnSTViCNnLyJ4y5kNJG/yT38Dh6lPE57WEB7R9ugVQBO8ztxLvSHv1hwudLhohQ0QMVSlnBUFOWtwj+14IwHtogQEYSBeIHneIp84bvRGGMpIkRUEJ5gqWkJtqSBNCw7pwkjjBCQbfR79X5gP61f1D2ASCINoSwa5hv5RtbxFWhrtRXaDNDStAvaXrA0tNSweIPlVcsgS0ewfGdZbnkPrNUtQZYUsL5rHWbtAFqOdlk7BHKf3C8PUmgKNW2M9pp4Cs5vOl8/8UU4/dvpx+PtIL4UC4UTE5rlePmxnAqlfvKc6VkVKneoPC9yD1QdUXVrVCx4LPJ4y6M2yG/lOrmx8PbEMXFI7IYjbkc3Hl8Jlz++vPfKaGAnv+DE3+dRWUQRCWKJNle8B5QrYiXuAxwgBuyD9GH2WcARjkoXknPnTbeYwWw5Hyq0CNwbsAzcPdwvus8BVsiV0pUECeZYW/4YXI6y4G4dlAV3q/BPBQ4cb5uGq4xIEUE4IPn5pryFeuKJJ8hX5QhGgxwqR8o04H1eZwo4nc5pFnPkAnAPch/u/iZ4uHskeFhATpAT5XSgA62uV/izIPS79I56f+iU3HF6+3hoV6/t6TbPAa3lKR4AMUbEi3WgfeCwZMRD2hARBZZmWrIWDFprbazFDlc3pzdOvx3m5HxyYpEvHEk6mnksCLSymof2Ny5OMUtMFx/B1fj00RlZEBN06NfDdaHZHc26NWoLbOUAOgXPizPKHlmetzyu3Q11vqndpeb34L3Ja6LXXhAVxH3CQuGmoJECy97U3tb+DETviH4i9mOw7badsgeB9UFrB4sLWfxFJSpSAbQwUUMLAurhXqQqAAmc5RzoL+mvyeXAFg5fO6+wUAxLSzui7dO+g8plopZGzgHL25Z4yxdgH2M/b7/g6LJLo2g5f3JR3py5o4objLLgbhX+GmTimiyZKb8ukMhFkN/I1azDMT/uZtwFdahNTbCH2Wvb74esA1k5WU+DuEe05y7nm5FdZXf6gne69xavBlD+IX97OR2kkO7443LSaRkvz5AAmtTStaNwxyuturSoCj0adPvqvrHQ9aEucR2PQZej9w2+dwR07tnp4j2lodPWe59oPxM6tL7nfNs20N633bY7m0PX6fdF3VsVwnzCRoVcBv1x/Vl99HU6YEQb6p/pK+17Yf+vBz+NyYCcr3J+yS0DoqFoKG4r/Dj0d/TxcgE0imhYu/4HUHdQnek1u4DeXu+iD3Tidpgv5oipkL4y/VzGGxAbefjU0SQQg8QzPIHr8xUNi1iukWvkdxRen6+gfr0lxvA6eIR52NznA33EA6IHTucwlY1lc3k3lOlZxr/0QKg/vv6SutXIdzG7elx/DTIxoyiLVM1D8e+iBO5WwQyXL0PpvArHrvxQzUwmW+SPbANqyDqyKeBWxDG9wmjDHeJ2sP1kO2TzhSv3Xvm/q3WAx3hU9HG+GfmRnCinQakBpZqUWg9NtjXe2aAciK/FMhaB/FH+JH8h/wWgIAzLV1+qf2s/CEGxFZ4KrAP1ptRbXacb5GTk+uR2B9sw27u2b8E21PZ/ttVge9n2lu0bsL1oG2P7GmzP2d60LQf7SvsP9ouQ1SSrb9aPkLEqIz5jMDCCYeLF6x2Q46qJ+qK2CIYjg49UORYBqe+lHkr7GoQm7CK18POi36V30gdARJPwhaHuEOwZ/E6lyqD31QfoIwr/e+0dbYwYDOe6n//lghecHhRni58A4nOxQLzv+uWWv8nf+B306foi/UfgjGMM1mVeY7gYAn47/N7wXQ5arNgr1pE3AbxAjGoQ9rb27vZXoVHfhk/W3wLhsWHVQqZD7lO5w3N/BtFANBD1XOyTIH8eoa1ode4UxYNyUZZ0zIwQ2/iFnSC7yPvpi2M+1v0utGNOEJ/CNDkb9A9llPwMKMXjLpeJcQIRKkKoBLaDthP2URBf9szahKMgg2RLeYL8N+nC3oQzyCATuMJlrsL93bv9et9c2PXR7up7fWF78x2Nds0De0/7QPtU4G7upg3589fOcIaz5Lnkyi4o293vVXii+uP2R3pD1KbIweGPgewnw2QzHOVeTjpxfL+K7eJ7uNrx6ivpxyFx8MVpl5JBlBGewhyjuU4mD7My9tn+50qfHwRxr8Y9d2YRBHwXsLj8BCdOsJmbdAc/89015/Eil0i6znk1C9/eK+7WGsCRHUdePjYMUvxTzqRmgKgrvIQrlpe5nxWslGvANtj+lv0Z4DMy5Rljf1eduM5m996W4/X5UKdNba1mJQh8JnBGwD4473s+7EI70PZoP2pzgTARJkKARfJT+QXYy9rD7fdAxcyKY4KawcBqj498ZDpkf519Nmcm5NTIeS73NyhVupSnpY0Lx2cxMv0YZXfkYUpxDGhjvFCpkjklGmXBlXSMeVfyW7lB3wW2AFsN28NAOGFORSGalDLGxAbJ53kVdKF761X5o0V4IzEzSSTKFGmH/T8c+CRah6xfsy5n9QPxjHhKDHCiHePBqA/SX9bfgWARPKZiCLxf+Z0po9+B1+8akfXy19CtfdddndbDnRltfm71GtyR1XpPywXQvkc797uGwZPNB/Z8LAKmVJ/49PuH4KH9D9bsOQsEwiaSQR6WzgUzmAJhBIXEdY8/kfAkXGhyYdHFPaA9ow0QXZ1oZ7n4UiyAq8lXq6dvh5gzsV8c2QbiNTFMDKFwV5opGEYUqJnJpFAhMYReP6+n6WXgQM7BAzFRkHNP7oDcr0A0Fo2EC5W/8zjFKeIg+4es+Oy7Qf9Z3yljuTZjjlPoKXqWLA9V36myL+oMvHD74PpPToHQcaFXg18Cy72W1pZwIFYelkfBY4rHUPdQuM1WL7jOShjbbfSZEW2g0fKGa+qXgTiP+HlnqoFcIr/SN5PvYnQWX3zxBekhvWUQUN3wfPg4yvooSjbKgivphBBMJdClXkW2gtx2uf1ym4Gwib1MBjazx6lktB544g68zhvyLdCX6W/LBwFv4Y2jMnagSxNynUTz1KQ4A/un7X8leg8cSz3ufdIf6sTVrlLTA+w2u81uI98FW3D/PfAA/Q39LX0GBD0f9FSFXjBg62NP9O0Otv62PbbNYFtjm2xPBaYyTXYEcZ82VIsH93Fufd3agGgkIkUo6Hv1Hfp2kK/JkXIazucoNFKPydMyW3rCtld/mbxjIVzxvuJ3ZS5ov2jfa59RaOYPEeAonGkbaw+x3w3Rt0VnHToNtvO247bDIMKEI3o0XsaTcOOuhxgrRokRkFElo1dmDBzaF7v4yE/8sX5eUTAy1iS9nLQ3eSbYPrLF2x4D63vW+6x1Qf4st8rthTcj98sDMhq0R7QHtHbQc0WPl7u+Do1/bHy1wWWIaRmz9PBwSB+R7pHRA4K6BL0bOAZqPVLzreorIKBVgF/5H+By88tJV2IhNi326SPr4Db/eqNq24FULrjk2jfqwMmJ+hi5DPQf5dtyAPC6Ufg0ifMcu3HXR3FjUQJX0vF1vAHLi7K0rAR2f3uU3VFZOUEEGNuccaId0x4oS1n8QLQQzWkKnJSSNAAq3Izua02027QIuOh3qVJSI/h62zdx37pBjSbVV1R9DbSeWg+tK8iV8hu5lsIfsKbQzdYX6qvJezBrXhraBHB/3b2/FoUjZddY4HaqkwL6dn2avpF81143HilKFJ0ZHRl/f/zJhCdh3Rvr13/fBhhGBFfIrwxe6IQ2wxI8LmLFb3DklaMdjgfC5fKXT16ZAL7VfI/7GGH6staNux6ijWgpasKlCkmfJX0Pca3js8/UAu018ZJYAcAc/q8I7W4VP4p1cL7hha2JxyHjvswNmTngU73MJ2WmuNCQafkvdLgeRYSIEGEQuT9iZ/g3UHlW1KTIL4CmVKcq8CHjZV3QK+lechUgCaEMxH8Tf0fCFji89miN41VAvCseELvIL6DqLEYhX9mBTrIX8Jj8hMFANXYRduOui+LmoASupHOCk5wGravWTqsKHlkeBz12Am/Kj+RvACQ71c5xx9iSNkqbZrkfPGd4/uJxFNjGL9J0IVW5Cf03H/hx4rjYB6sWr35o3XhoPfH2+c03wl3Rbba0mgO20na73QtId7EckCEU5pt/gVzlqitjQXkYwQXmmFvu57kbc6/CgoRPz34+EU54nXzl1AQQV7VULR4INOqGOYkYJoZoj8C558/7XSgLifpFLm6HskfKRvhFgn2TfbvdmRcYJ9F6iM6iJSRcTuh5zgopo1KqpcaAaC8qCa9/0O5Rbb/2HZyynfourh4cG3rs+AkrNJ7QKKSBAHuWPdfuCK93rjyTETQk42ScPJP/vqAP19/T112zXXcGGGnrJEfAst+yzbIAtvX9hZ0fwcXMiw9ceh54mAdFT+ALZrmUbPk39vA7WLpYqlhagna/5VNtNHAv+xl6466L4uagxuBKOiMZxdvgWdozwWMk+DX0O+PrC7IXfejvfDNynVwvN4H7aveZbl2gwjsVAgJPAt+zmR8pPAqxqBhPJi1cVBTekNIhZWbaK/Bh14/emPIG7G99MCjmZbBctpyxfA+iuqgmilI37kZj1CUTV0WKiAM9WK+it4bPJ33ZfMVWWH7uq9dW7QLupA2tQARR4e+SLBeGWCVW8BmkN08fnJENl/Zeqp/cAkSKSMSVCc7O8oF4V4yBhGoJy85Wgqy9WZnZj4N4RQwRg4verDgiYsRuSJ2RdjptGayM+ab32qGQG5HbKvd9EOPEGPE6N75ckpGSSxutjdAGQqLPxeGXZsC3b607t2EjyFp6ff1eYCYz5Tzyk0I7ibwqs6UHlF3od7/vMPBb6fuk7wyQ2dIuvZ1vR1E8KIErqZjBFY/qT+qvQ0ir4A2VekHQzgp9AsNAf0f/SF/oQntG0lrLOstS7R2o27r2szUrg/Ul66PWKJCxMla6klLJVTLJIgssdSyRmhscvv+I13EPGFn6zffe7gc7tV9L/XYcxFOiv+gKWjeto9acf0/ojP2IKBElIsAy3jLG0g+y/y/7y2xvWDj+015ftIJJr035eGZnyIzJ1DJHgjgg9oif/0E/f2Irv4B1nuUjy6PgWcvT4jHDUWGc5TfhOGfxiVwIlwOu9LniY2SG8QQCXLM8/4IRtaq9pA3S+sC3w9cd3/ANrHt2/bZNYwwXcgKIgeJx8Sj/PNzemGcnhomh4nmQa+UmuQeWzVreYOU0iB54qP7hASDWasu16SAnyknMIM/F7SzyuIyXl8H/e/+B5Z6HGt1qTKg6EvQp+mx9OdcWQFWUQJTAlVQyySQTGMVIMQxavXJ7j+ZNoey4so18+4IMlJVkNRfaMwXzbf0DOQ+aa80ymgRA2Nqw6iELQVaWdWV7bp4lZ2K8wVvusjTTKkLMh4fuP/IKDO0+LO3NOjCvx4KqS2pBcnDykJRHwOJpybHsN1xgG0DcLe4UrW9AP4wJ82KumC0mg2WLZZVlAtCWu7gDYpMOf3VkE4zePbbZe0fhY49JlWdchivDrqy6+gBoA7SHtY7kCbfLmNdjoP6cPhYqbqjUJigJQlaGVAv+CuTz8lVZhPlohZ7+LXILW6HKvMoplcuAdw+vyFKzQD4s+8mn/vl1FfHipNgPV+dfPZz+JoyfP2H31O2wrvz6lzbVB+khS8uKoF3RLmi/k1/NwVnLzsgBqjXW6mnhIH4Vv4hNsPbxdT9t/AAWzFo04POOoB+3n9OtwKPycTkIOGukiHPRRS1XyzVyPbhfcN/u/jy039D2pTvPg+cCzzc8g0DOkZ/IRTf+OiluDGoMroSij9BH61MhbF1YzeBA6Hpnlz4dB4N1snWkWxvQX9D76elAhjFmZY4xpZNBBpBFlswm37Jww024AVWpSmWI8I34LvR36F6u65RO4TD5rqnfzT4Cco6cKzde4yq8WRhCarnL0lQLgvOPXXgmMQnG3/7RiCmD4Ls1G45sHgvdm3Q912ky3B7esmyzHKj4WsUPKqwHj1B3H/cEoL94TPQF2Uy2lO2Ap+Ug+TJII6WVqC1qUwPYz2/iZxDvO1x0+vP6UP19SG+SPjDjDBz78HjLE5XguzMbmm8uB2t/Xf/KpnshQTt7/7lzoL0rxogPQbtHu1O7jfwKz0XEzCgjzohgrTS02373uDYDoOL/BQ0IHAVyiBxCLmgLtI+1x67TUMF1yf72U7FKrGAJNN3cNLXho3B7t5btm1WDDXU39vuhOVjmWmZbJlN4VGtBZJJJFmjR2m5tDZyrfD75Qkt487kxL7y7AGJWHXry8OvQO6zXl92qQEhcsHelA2AZbRlq6QHykDwmL4L8WE6SM4FQQggGkS7SxBkQTWlCQ0i+lFot9RKsfOcbj7W1YVbEnJcW/A6pg1Oj0pJBzNQeFn6gadoS7SRYva051q1gedByj+U5oC+dCCNf8EzLzhtvvHBMn/E21r1BlBWlhQ5tYu+oensONLDX9687AXak7MzZHQAWaZEWZ+Z1Kv5VlMCVNMw32SlMYzZEbYmcGNERTi877RV/HOKqxoWf8QNhERtYCcJLZImLIHwE4gqIC+KMiAVWivkiEER96lPXeNOMA5kqM6QF6MVbeIBvI9/Nvo3Bt6/PYJ8jkLovrUVaUTJQFJUssskGba42TRsD9l16F70V7Fm699t998B+vwNLo3+ASmUrLg7qDHUa1NlbU4e6Y+ssqzUPIkXE4PB0KN+xvN1/EZTpXDrNuw6I1iJOxIBtgb2HfTekRKecSG0GF+onfpm4Fo6MOhJ8fBDsG7d/QPRWOLzv8OqjmZAcm1IrtTSIMWIcI8EyW/PVRgHuTOUjbtwY0hg5Tr4PXq96nSr1K3hHel/yegg2zf8+7qc+oF/WbXoFoDISL/KrF+hG2aNr169dmimy/vy5WR3hGQbSCSw+lj5aC4i8O6Jc+JPg7u++070m2H6wbbFtBdFetBN3/oPju0o66aCd1Y5rWyHNLe2+y2VhVtKcGQuqwYZJG1/7YTi06dom/PYT0PSHxvc2mAWh74RWD3kVPD/wCPFYDvod8h69HyQ9nrQpZSMcaHKwVPTdsLHTps5bdsLv7vsuHRSQ2zB3cO4ToH3nqJwud9i32vdDqpbWNS0DttbaVn77cHDv697Z/SowiGn8BpzlHOdAPsbjDAb8ZQVZBWSuRJYBWVqWlaEgm8vb5T0g5mlvamMhfFd42dAW8Ov9u3vsbQSyn+OwRXlj+oCiRFDgu4a/f2BgaKhUxSCKC+PBZKlqCbRcApEiLnIS8DMmmD7HIPEkiDfEa7wCjOZNMQzESwxhENBNdKETEESQCAT2slfuB/mGHM3/gawrG8hWwDRmMBfsm+177Fkgf5S/yEPkF/YsLswougPyoIwBOUy+KSeD3lt/VH8ZtE3aGm0euO91X+32FJQ67LmiVEtwf8KjvXsaiFV8zRLQz+uXdR/IfDVrXpYPZPXMGp59HGwDbMNta4BoYoh1zNfTzhhBJfH8MefnzfgVGBYmv7KdTWA5Yfndsgz4gi/56pr96sZS5i31vHX9b793bmkkw2YoLzEY7Pvtp+3ewFCGM5rCK3gX9XqekWc4C7KqrKffA/JO2U52BY9RHn09MqHMlTJrS3uDe4B7pvsX+cE9GU0yns3IgKvNrw5JLw26TXfXI0B7UOus1QXxkOgjepAX9SqNjC7aGrFUTAXrB9bXLZ2B1awUn4PoKO6lHY5pI1dBrpJrWAeMZwLTQI6Vb8n3gff5kMnAAhbKz0AekrEcIS84y77Y/q39NHmZhvIyDyn+VZKSEhPj48Vf9EwJXAlHnpKnZBz5uf3MwXnTRWaOAWUZy2xH9F9e7jzdeBCaPzwzbN/MYGIImagvbhN1yXfR3KwH+43CmE4gt8ntcifwEq8wEuQ0OUN+kv89UUSJCBATxUe8A7zECzwDoqqoKipT/A8kY36dPGJkUjGT+sLf/zrF3/zPVcy/lORluBFVRBVRmX8/aMKwOOUKuVKuAdlQNuFOYC4L5BIgjFBCHK5VsQRYJOaL6SDMoJiC7lMzufg5eY7zwHZ2yN3ku/Jzjd+R6VI0U7uZrkrjvOQJvVnFw2K4bo2xwzxXvnJNFitK4BQKhULxn6QggVNRlAqFQqH4T6IETqFQKBT/SZTAKRQKheI/iRI4hUKhUPwnUQKnUCgUiv8kSuAUCoVC8Z9ECZxCoVAo/pMogVMoFArFf5JCBC47sbg7qFAoFApFwWSnFfRNIQJ36fni7rpCoVAoFAVz6bmCvilE4E5tKu6uKxQKhUJRMKc2FvRNIQJ3SBVlVygUCkUJ5lCpgr4pROD2v1XcXVcoFAqFomD2jynom0IE7kCb4u66QqFQKBQFc6B1Qd8UInBHOxd31xUKhUKhKJij9xX0TSECd35RcXddoVAoFIqCOb+4oG8KFDhHATl7Y8fa5tTiPgSFQqFQKPLZfMnQqUYFbeFkJpN5KppSoVAoFCWIeX6FbeGkwH2fXtyHolAoFApFPt9fLWyLQgXOYQKeL+tYS+hT3IekUCgUiv9lEvr8UZcKxsVky8MXu7a9QqFQKBQ3Eud1yHmBs2DBsmpucR+aQqFQKP6XWfWJs1s6LXBJiYnn4k9decaxNql7cR+iQqFQKP6XmNTT4Zq88qyzf+F6PTgLFiwfHi7uQ1UoFArF/xIfxrr6Fy4LnMOSSzB2NH1ZcR+yQqFQKP7LTF/qsNwSYlz9y6JX9HbHHffRwcV96AqFQqH4j6KhoY0OKfqfF5Gkc4ln4o9fut2xNiiguM+DQqFQKP5LDCqbdDHxfPxpU2dcp+gWnIkVK9ZZFx0rCY8W9ylRKBQKxa1MQh888cRjduo/bUncqC75VwwMDo2q6kYOueQeySnW86NQKBSKWw8NDa2ap8NyO5r9z5u7QSSdS0yIP3E0F4FAPKIETqFQKBQu8Ij9RgmbyQ0TOJOkS4kX4uOWeDjWVJSlQqFQKK7H9BWOKMkl1hvd8g0XuDw88MDjhSjHyrbAm7YfhUKhUNyCbCuPF16UeiH8Zu3hho3BFYR/WGBEaHWvyaSTQcaBCMenUV1u9n4VCoVCURI5sdIRRFL3TFJCYlz8sYznb9aebrrAmfiHBUaG1igzg3TSSf89yPFpVPd/a/8KhUKhKE5OrHZ49uonJJ1NjI8/5nzKraJy81yUfyIpLvFkfOyVZ/HGG6+6Zxyfbiv/b+1foVAoFMXBtkDDYjv1bwmbyb9mwf0Z/5DA8NBqlt1kkknm5NOOTwf1KK7+KBQKheJGMn2ZMcYWlRSfeCr+iL3xv92DYhO4P+NfPrBCaNjDNiQSudhS3P1RKBQKRVF4JMeIivQo7p78ay7KwjCmF1ixYsVSzdPxqaogrlAoFCWbhEcd85+ruZcUYTMpMRbcn/EPDgwLrWqBLLLIesrP8en0lOLul0KhUCgABgXggQfusy4mnU2Mjz+ulzg9KXEdKgj/CoEVQyPKb8OGHftYI0hl0APF3S+FQqH432D6MoelNjrY4XErehLkf4tbRuD+jGPMLriWY8zu1RqOT1/8qrj7pVAoFP8NJnV3LD88bNRjc7ngaHFzywrcn3EIXpkZDsHrOtDx6fuPOJbBXxR3/xQKhaJkYsY6DF/sWK6a6xC0K88Ud8/+Kf8ZgSsIf//AwNDQIGPsrm1px/LxVMfybjUPT6FQ/I+wOdWxnOftWH6f7hCy82WLu2c3i/+8wBWEQ/gsvznWggxLr+oax7Luz45lvTGOZc1MxzKivWNZfqpj6eFb3MehUCj+V8hOdCwvGamtTm1yLA8ZgrX/LcfyQBvH8mhnx/L8IoeQ/fvz0BQKhUKhUCgUCoVCoVAoFAqF4n+Y/wcfw0JrftxmmAAAAABJRU5ErkJggg=="

const IS_ITERM = process.env.TERM_PROGRAM === "iTerm.app"

const showSplash = async () => {
  const isIterm = process.env.TERM_PROGRAM === "iTerm.app"
  const isKitty = process.env.TERM === "xterm-kitty"
  if (!isIterm && !isKitty) return
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  const imgCols = 28
  const imgRows = 14
  const padLeft = " ".repeat(Math.max(0, Math.floor((cols - imgCols) / 2)))
  const padTop = "\n".repeat(Math.max(0, Math.floor((rows - imgRows - 2) / 2)))
  const frame = (b64: string) =>
    `\x1b[H${padTop}${padLeft}\x1b]1337;File=inline=1;width=${imgCols};preserveAspectRatio=1:${b64}\x07`
  process.stdout.write("\x1b[?25l\x1b[2J")
  for (const [b64, delay] of [
    [SPLASH_F1, 60],
    [SPLASH_F2, 80],
    [SPLASH_F3, 700],
    [SPLASH_F2, 60],
    [SPLASH_F1, 60],
  ] as [string, number][]) {
    process.stdout.write(frame(b64))
    await Bun.sleep(delay)
  }
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h")
}
await showSplash()

// ── Renderer ──────────────────────────────────────────────────────────────────

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
})

// ── Layout ────────────────────────────────────────────────────────────────────

const rootBox = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
})

const headerBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  backgroundColor: theme().headerBg,
  alignItems: "center",
})
const headerText = new TextRenderable(renderer, { content: "", flexGrow: 1 })
headerText.fg = theme().headerFg

const mainArea = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "row",
  width: "100%",
})

const fileTreeBox = new BoxRenderable(renderer, {
  width: TREE_WIDTH,
  flexDirection: "column",
  borderRight: true,
  borderColor: theme().treeBorder,
})
const treeHeaderText = new TextRenderable(renderer, {
  content: "  Files",
  width: "100%",
  height: 1,
})
treeHeaderText.fg = theme().treeHeader
treeHeaderText.backgroundColor = theme().headerBg

const updateTreeHeader = () => {
  const th = theme()
  if (prMode) {
    const counts = { A: 0, M: 0, D: 0, R: 0 }
    for (const fd of fileDiffs) {
      const s = (fd.status ?? "M") as keyof typeof counts
      if (s in counts) counts[s]++
    }
    const parts: string[] = []
    if (counts.M)
      parts.push(`${fg(th.commentMark)(String(counts.M))}${dim("M")}`)
    if (counts.A) parts.push(`${fg(th.successFg)(String(counts.A))}${dim("A")}`)
    if (counts.D) parts.push(`${fg("#f07178")(String(counts.D))}${dim("D")}`)
    if (counts.R)
      parts.push(`${fg(th.treeActive)(String(counts.R))}${dim("R")}`)
    treeHeaderText.content =
      parts.length > 0
        ? t`  ${dim("Files")}  ${parts.join("  ")}`
        : t`  ${dim("Files")}`
  } else {
    treeHeaderText.content = t`  ${dim("Files")}  ${fg(th.treeActive)(String(fileDiffs.length))}`
  }
}

const fileListBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
})
const BADGE_WIDTH = prMode ? 2 : 0
const treeAvail = TREE_WIDTH - 4 - BADGE_WIDTH

const fileTextMap = new Map<string, TextRenderable>()
for (const fd of fileDiffs) {
  const label =
    fd.file.length > treeAvail ? "…" + fd.file.slice(-(treeAvail - 1)) : fd.file
  const badge = prMode ? `${fd.status ?? "M"} ` : ""
  const t = new TextRenderable(renderer, {
    content: `  ${badge}${label}`,
    width: "100%",
    height: 1,
  })
  t.fg = theme().treeInactive
  fileTextMap.set(fd.file, t)
  fileListBox.add(t)
}
fileTreeBox.add(treeHeaderText)
fileTreeBox.add(fileListBox)

const diffRenderable = new DiffRenderable(renderer, {
  diff: currentFileDiff().raw,
  view: diffView,
  showLineNumbers: true,
  filetype: getFiletype(currentFileDiff().file),
  flexGrow: 1,
  addedBg: RGBA.fromValues(0, 0, 0, 0),
  removedBg: theme().removedBg,
  contextBg: RGBA.fromValues(0, 0, 0, 0),
  syntaxStyle: buildSyntaxStyle(theme()),
  treeSitterClient: getTreeSitterClient(),
})

const diffColumn = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
})

const commentBarBox = new BoxRenderable(renderer, {
  height: 3,
  flexDirection: "row",
  backgroundColor: theme().inputBg,
  visible: false,
  alignItems: "center",
})
const commentLabel = new TextRenderable(renderer, { content: "", height: 3 })
commentLabel.fg = theme().commentMark
const commentInput = new TextareaRenderable(renderer, {
  flexGrow: 1,
  height: 3,
  keyBindings: [
    { name: "return", action: "submit" },
    { name: "return", shift: true, action: "newline" },
  ],
})
commentInput.textColor = theme().inputFg
commentInput.backgroundColor = theme().inputBg

const commentPreviewBox = new BoxRenderable(renderer, {
  height: 2,
  flexDirection: "column",
  backgroundColor: theme().inputBg,
  visible: false,
})
const commentPreviewLabel = new TextRenderable(renderer, {
  content: "",
  width: "100%",
  height: 1,
})
commentPreviewLabel.fg = theme().commentMark
commentPreviewLabel.backgroundColor = theme().headerBg
const commentPreviewContent = new TextRenderable(renderer, {
  content: "",
  width: "100%",
  flexGrow: 1,
})
commentPreviewContent.fg = theme().inputFg

diffColumn.add(diffRenderable)
diffColumn.add(commentPreviewBox)
diffColumn.add(commentBarBox)
const singleFile = fileDiffs.length === 1
if (singleFile) focusedPanel = "diff"
if (!singleFile) mainArea.add(fileTreeBox)
mainArea.add(diffColumn)

const footerBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  backgroundColor: theme().headerBg,
  alignItems: "center",
})
const footerText = new TextRenderable(renderer, { content: "", flexGrow: 1 })
footerText.fg = theme().mutedFg
const footerPosition = new TextRenderable(renderer, { content: "", width: 24 })
footerPosition.fg = theme().mutedFg

const MODAL_W = 46
const MODAL_H = THEMES.length + 7
const settingsModal = new BoxRenderable(renderer, {
  width: MODAL_W,
  height: MODAL_H,
  flexDirection: "column",
  backgroundColor: theme().bg,
  border: true,
  borderColor: theme().modalBorder,
  position: "absolute",
  visible: false,
  zIndex: 10,
})
const centerModal = () => {
  const top = Math.max(0, Math.floor((renderer.terminalHeight - MODAL_H) / 2))
  const left = Math.max(0, Math.floor((renderer.terminalWidth - MODAL_W) / 2))
  settingsModal.setPosition({ top, left })
}

const EXPORT_MODAL_W = 60
const EXPORT_MODAL_H = 8
const exportModal = new BoxRenderable(renderer, {
  width: EXPORT_MODAL_W,
  height: EXPORT_MODAL_H,
  flexDirection: "column",
  backgroundColor: theme().bg,
  border: true,
  borderColor: theme().modalBorder,
  position: "absolute",
  visible: false,
  zIndex: 10,
})
const centerExportModal = () => {
  const top = Math.max(
    0,
    Math.floor((renderer.terminalHeight - EXPORT_MODAL_H) / 2),
  )
  const left = Math.max(
    0,
    Math.floor((renderer.terminalWidth - EXPORT_MODAL_W) / 2),
  )
  exportModal.setPosition({ top, left })
}

const modalTitle = new TextRenderable(renderer, {
  content: "  Settings",
  width: "100%",
  height: 1,
})
modalTitle.fg = theme().headerFg
modalTitle.backgroundColor = theme().headerBg

const modalThemeLabel = new TextRenderable(renderer, {
  content: "  Theme",
  width: "100%",
  height: 1,
})
modalThemeLabel.fg = theme().mutedFg

const themeSelect = new SelectRenderable(renderer, {
  flexGrow: 1,
  options: THEMES.map((t) => ({ name: `  ${t.name}`, description: "" })),
  selectedIndex: themeIndex,
  wrapSelection: true,
  showDescription: false,
  backgroundColor: theme().bg,
  textColor: theme().modalFg,
  focusedBackgroundColor: theme().addedBg,
  focusedTextColor: theme().modalFg,
})

const modalViewLabel = new TextRenderable(renderer, {
  content: "  View",
  width: "100%",
  height: 1,
})
modalViewLabel.fg = theme().mutedFg

const VIEW_OPTIONS = ["  unified", "  split"]
const viewSelect = new SelectRenderable(renderer, {
  height: 2,
  options: VIEW_OPTIONS.map((n) => ({ name: n, description: "" })),
  selectedIndex: diffView === "split" ? 1 : 0,
  wrapSelection: false,
  showDescription: false,
  backgroundColor: theme().bg,
  textColor: theme().modalFg,
  focusedBackgroundColor: theme().addedBg,
  focusedTextColor: theme().modalFg,
})

const modalHint = new TextRenderable(renderer, {
  width: "100%",
  height: 1,
})
modalHint.fg = theme().mutedFg
const updateModalHint = () => {
  const w = fg("#ffffff")
  const d = dim
  const s = d("  ·  ")
  modalHint.content = t`  ${w("↑↓")} ${d("select")}${s}${w("tab")} ${d("next field")}${s}${w("↵")} ${d("apply")}${s}${w("esc")} ${d("close")}`
}
updateModalHint()

settingsModal.add(modalTitle)
settingsModal.add(modalThemeLabel)
settingsModal.add(themeSelect)
settingsModal.add(modalViewLabel)
settingsModal.add(viewSelect)
settingsModal.add(modalHint)

const exportModalTitle = new TextRenderable(renderer, {
  content: "  Export to Markdown",
  width: "100%",
  height: 1,
})
exportModalTitle.fg = theme().headerFg
exportModalTitle.backgroundColor = theme().headerBg

const exportModalLabel = new TextRenderable(renderer, {
  content: "  AI prompt  (optional — prepended to the review)",
  width: "100%",
  height: 1,
})
exportModalLabel.fg = theme().mutedFg

const exportPromptInput = new TextareaRenderable(renderer, {
  width: "100%",
  height: 3,
  paddingLeft: 2,
})
exportPromptInput.textColor = theme().modalFg
exportPromptInput.backgroundColor = RGBA.fromValues(0, 0, 0, 0)

const exportModalHint = new TextRenderable(renderer, {
  width: "100%",
  height: 1,
})
exportModalHint.fg = theme().mutedFg
const updateExportModalHint = () => {
  const w = fg("#ffffff")
  const d = dim
  const s = d("  ·  ")
  exportModalHint.content = t`  ${w("↵")} ${d("export")}${s}${w("esc")} ${d("cancel")}`
}
updateExportModalHint()

exportModal.add(exportModalTitle)
exportModal.add(exportModalLabel)
exportModal.add(exportPromptInput)
exportModal.add(exportModalHint)

headerBox.add(headerText)
commentBarBox.add(commentLabel)
commentBarBox.add(commentInput)
commentPreviewBox.add(commentPreviewLabel)
commentPreviewBox.add(commentPreviewContent)
footerBox.add(footerText)
footerBox.add(footerPosition)
rootBox.add(headerBox)
rootBox.add(mainArea)
rootBox.add(footerBox)
renderer.root.add(rootBox)
renderer.root.add(settingsModal)
renderer.root.add(exportModal)

// ── Scroll helpers ────────────────────────────────────────────────────────────

const findCodeScrollable = (): any => {
  const walk = (r: any): any => {
    if (typeof r.scrollY === "number" && typeof r.maxScrollY === "number")
      return r
    for (const child of r.getChildren?.() ?? []) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(diffRenderable)
}

const ensureCursorVisible = () => {
  const scrollable = findCodeScrollable()
  if (!scrollable) return
  const viewH = Math.max(
    5,
    typeof scrollable.height === "number" && scrollable.height > 0
      ? scrollable.height
      : process.stdout.rows - 3,
  )
  const contentIdx = rawToContentIdx(cursorLine)
  const sy = scrollable.scrollY as number
  if (contentIdx < sy) {
    scrollable.scrollY = contentIdx
  } else if (contentIdx >= sy + viewH) {
    scrollable.scrollY = Math.max(0, contentIdx - viewH + 3)
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────

const isContentLine = (l: string) =>
  (l.startsWith("+") && !l.startsWith("+++")) ||
  (l.startsWith("-") && !l.startsWith("---")) ||
  l.startsWith(" ")

const rawToContentIdx = (rawIdx: number): number => {
  const lines = currentFileDiff().lines
  let idx = 0
  for (let i = 0; i < rawIdx && i < lines.length; i++) {
    if (isContentLine(lines[i]!)) idx++
  }
  return idx
}

const nextContentRawIdx = (rawIdx: number, dir: 1 | -1): number => {
  const lines = currentFileDiff().lines
  let idx = rawIdx + dir
  while (idx >= 0 && idx < lines.length) {
    if (isContentLine(lines[idx]!)) return idx
    idx += dir
  }
  return rawIdx
}

const firstContentRawIdx = (): number => {
  const lines = currentFileDiff().lines
  for (let i = 0; i < lines.length; i++) {
    if (isContentLine(lines[i]!)) return i
  }
  return 0
}

const totalContentLines = () =>
  currentFileDiff().lines.filter(isContentLine).length

const currentContentLineIdx = () => rawToContentIdx(cursorLine) + 1

const jumpToHunk = (dir: 1 | -1) => {
  const lines = currentFileDiff().lines
  let idx = cursorLine + dir
  while (idx >= 0 && idx < lines.length) {
    if (lines[idx]!.startsWith("@@ ")) {
      const next = nextContentRawIdx(idx, 1)
      if (next !== cursorLine) {
        prevCursorLine = cursorLine
        paintLine(prevCursorLine)
        cursorLine = next
        paintLine(cursorLine)
        ensureCursorVisible()
        updateHeader()
        updateFooter()
      }
      return
    }
    idx += dir
  }
}

const jumpToComment = (dir: 1 | -1) => {
  const file = currentFileDiff().file
  const lines = currentFileDiff().lines
  let counter = 0
  const lineNums: Array<{ rawIdx: number; lineNum: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      counter = m ? parseInt(m[1]!, 10) : counter
    } else if (isContentLine(l)) {
      if (!l.startsWith("-")) {
        if (isLineCommented(file, counter))
          lineNums.push({ rawIdx: i, lineNum: counter })
        counter++
      }
    }
  }
  if (lineNums.length === 0) return
  const candidates =
    dir === 1
      ? lineNums.filter((x) => x.rawIdx > cursorLine)
      : lineNums.filter((x) => x.rawIdx < cursorLine)
  const target = dir === 1 ? candidates[0] : candidates[candidates.length - 1]
  if (!target) return
  prevCursorLine = cursorLine
  paintLine(prevCursorLine)
  cursorLine = target.rawIdx
  paintLine(cursorLine)
  ensureCursorVisible()
  updateHeader()
  updateFooter()
}

const fileLineCount = () => currentFileDiff().lines.length

type DiffLineInfo = { lineNum: number; side: "old" | "new" }

const diffLineToFileLineNum = (lineIdx: number): DiffLineInfo | null => {
  const lines = currentFileDiff().lines
  let newCounter = 0
  let oldCounter = 0
  for (let i = 0; i <= lineIdx && i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (m) {
        oldCounter = parseInt(m[1]!, 10)
        newCounter = parseInt(m[2]!, 10)
      }
    } else if (l.startsWith("+")) {
      if (i === lineIdx) return { lineNum: newCounter, side: "new" }
      newCounter++
    } else if (l.startsWith("-")) {
      if (i === lineIdx) return { lineNum: oldCounter, side: "old" }
      oldCounter++
    } else if (l) {
      if (i === lineIdx) return { lineNum: newCounter, side: "new" }
      newCounter++
      oldCounter++
    }
  }
  return null
}

const selectionRange = () =>
  selectionAnchor !== null
    ? {
        start: Math.min(selectionAnchor, cursorLine),
        end: Math.max(selectionAnchor, cursorLine),
      }
    : null

const paintLine = (rawIdx: number) => {
  const lines = currentFileDiff().lines
  if (!isContentLine(lines[rawIdx] ?? "")) return
  const contentIdx = rawToContentIdx(rawIdx)
  const file = currentFileDiff().file
  const info = diffLineToFileLineNum(rawIdx)
  const sel = selectionRange()
  const inSel = sel !== null && rawIdx >= sel.start && rawIdx <= sel.end
  if (rawIdx === cursorLine) {
    diffRenderable.setLineColor(contentIdx, theme().cursorBg)
  } else if (inSel) {
    diffRenderable.setLineColor(contentIdx, theme().selectionBg)
  } else if (info !== null && isLineCommented(file, info.lineNum, info.side)) {
    diffRenderable.setLineColor(contentIdx, theme().commentedBg)
  } else {
    diffRenderable.clearLineColor(contentIdx)
  }
}

const clearSelection = () => {
  if (selectionAnchor === null) return
  const sel = selectionRange()!
  selectionAnchor = null
  for (let i = sel.start; i <= sel.end; i++) paintLine(i)
  updateFooter()
}

const updateFooter = () => {
  updateCommentPreview()
  const hi = fg("#ffffff")
  const sep = "  ·  "
  footerPosition.content = ""
  if (mode === "comment") {
    footerText.content = t`  ${hi("↵")} submit${sep}${hi("shift+↵")} new line${sep}${hi("esc")} cancel`
    footerText.fg = theme().mutedFg
    return
  }
  const sel = selectionRange()
  if (sel !== null) {
    const startLN = diffLineToFileLineNum(sel.start)
    const endLN = diffLineToFileLineNum(sel.end)
    const rangeStr =
      startLN !== null && endLN !== null
        ? `lines ${startLN.lineNum}–${endLN.lineNum}`
        : `${sel.end - sel.start + 1} lines`
    footerText.content = t`  ⬚ ${rangeStr} selected${sep}${hi("↵")} annotate${sep}${hi("esc")} cancel`
    footerText.fg = theme().headerFg
    return
  }
  if (focusedPanel === "tree") {
    footerText.content = t`  ${hi("↑↓")} files${sep}${hi("↵")} open${sep}${hi("e")} export → revu-review.md${sep}${hi("s")} settings${sep}${hi("q")} quit`
  } else {
    footerText.content = t`  ${hi("↑↓")} move${sep}${hi("shift+↑↓")} select${sep}${hi("↵")} annotate${sep}${hi("e")} export → revu-review.md${sep}${hi("q")} quit`
  }
  footerText.fg = theme().mutedFg
}

const updateCommentPreview = () => {
  if (mode !== "normal" || focusedPanel !== "diff") {
    commentPreviewBox.visible = false
    return
  }
  const info = diffLineToFileLineNum(cursorLine)
  if (info === null) {
    commentPreviewBox.visible = false
    return
  }
  const file = currentFileDiff().file
  const key = findCommentKeyForLine(file, info.lineNum, info.side)
  const comment = key ? comments.get(key) : null
  if (!comment || !key) {
    commentPreviewBox.visible = false
    return
  }
  const lineStr = key.split(":")[2]!
  const lineLabel = lineStr.includes("-")
    ? `lines ${lineStr}`
    : `line ${lineStr}`
  const commentLines = comment.split("\n")
  const maxVisible = Math.max(4, Math.floor(renderer.terminalHeight * 0.3))
  previewScrollOffset = Math.max(
    0,
    Math.min(
      previewScrollOffset,
      Math.max(0, commentLines.length - maxVisible),
    ),
  )
  const visibleLines = commentLines.slice(
    previewScrollOffset,
    previewScrollOffset + maxVisible,
  )
  const canScrollUp = previewScrollOffset > 0
  const canScrollDown = previewScrollOffset + maxVisible < commentLines.length
  const scrollHint =
    canScrollUp || canScrollDown
      ? t`  ${dim(`${canScrollUp ? "{ up" : ""}${canScrollUp && canScrollDown ? "  " : ""}${canScrollDown ? "} down" : ""}`)}`
      : ""
  commentPreviewLabel.content = t`  ${fg(theme().commentMark)("▌")} ${fg(theme().commentMark)(lineLabel)}  ${dim("↵ edit  d delete")}${scrollHint}`
  commentPreviewContent.content = visibleLines
    .map((l) => `  ▌  ${l}`)
    .join("\n")
  commentPreviewBox.height = visibleLines.length + 1
  commentPreviewBox.visible = true
}

const updateHeader = () => {
  const count = comments.size
  const file = currentFileDiff().file
  const shortFile = file.length > 40 ? "…" + file.slice(-39) : file
  const modeStr = prMode
    ? `${currentBranch} → ${againstBranch}  ·  ${commitList.length} ${commitList.length === 1 ? "commit" : "commits"}  ·  `
    : ""
  const lineIdx = currentContentLineIdx()
  const total = totalContentLines()
  const posStr = focusedPanel === "diff" ? `  ·  ${lineIdx}/${total}` : ""
  headerText.content = t` ${fg(theme().headerFg)("{revu}")} ${dim("·")}  ${modeStr}${shortFile}${posStr}  ${dim("·")}  ${count} ${count === 1 ? "note" : "notes"}`
  headerText.fg = theme().headerFg
  updateTreeHeader()
}

const badgeColor = (status: string, th: Theme) => {
  if (status === "A") return th.successFg
  if (status === "D") return "#f07178"
  if (status === "R") return th.treeActive
  return th.commentMark
}

const updateFileTree = () => {
  if (singleFile) return
  const th = theme()
  const treeActive = focusedPanel === "tree"
  fileTreeBox.borderColor = treeActive ? th.treeFocused : th.treeBorder
  treeHeaderText.backgroundColor = treeActive ? th.headerBg : th.bg
  treeHeaderText.fg = treeActive ? th.treeFocused : th.treeHeader
  for (const [file, text] of fileTextMap) {
    const hasComments = [...comments.keys()].some((k) =>
      k.startsWith(`${file}:`),
    )
    const isActive = files[fileIndex] === file
    const label =
      file.length > treeAvail ? "…" + file.slice(-(treeAvail - 1)) : file
    const status = fileDiffs.find((f) => f.file === file)?.status ?? "M"
    const isFocusedActive = isActive && treeActive
    const prefix = isFocusedActive ? "❯ " : isActive ? "▶ " : "  "
    const commentMark = hasComments ? fg(th.treeComment)(" ●") : ""
    text.content = prMode
      ? t`${prefix}${fg(badgeColor(status, th))(status)} ${label}${commentMark}`
      : t`${prefix}${label}${commentMark}`
    text.fg = isFocusedActive
      ? th.treeFocused
      : isActive
        ? th.treeActive
        : hasComments
          ? th.treeComment
          : th.treeInactive
  }
}

const applyCommentColorsForCurrentFile = () => {
  const file = currentFileDiff().file
  const lines = currentFileDiff().lines
  const sel = selectionRange()
  let newCounter = 0
  let oldCounter = 0
  let contentIdx = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (m) {
        oldCounter = parseInt(m[1]!, 10)
        newCounter = parseInt(m[2]!, 10)
      }
    } else if (isContentLine(l)) {
      const inSel = sel !== null && i >= sel.start && i <= sel.end
      const isRemoved = l.startsWith("-")
      const lineNum = isRemoved ? oldCounter : newCounter
      const side = isRemoved ? "old" : "new"
      if (i === cursorLine) {
        diffRenderable.setLineColor(contentIdx, theme().cursorBg)
      } else if (inSel) {
        diffRenderable.setLineColor(contentIdx, theme().selectionBg)
      } else if (isLineCommented(file, lineNum, side)) {
        diffRenderable.setLineColor(contentIdx, theme().commentedBg)
      } else {
        diffRenderable.clearLineColor(contentIdx)
      }
      if (isRemoved) oldCounter++
      else {
        newCounter++
        if (!l.startsWith("+")) oldCounter++
      }
      contentIdx++
    }
  }
  updateFooter()
}

const switchFile = (idx: number) => {
  selectionAnchor = null
  previewScrollOffset = 0
  fileIndex = idx
  diffRenderable.diff = currentFileDiff().raw
  diffRenderable.filetype = getFiletype(currentFileDiff().file)
  cursorLine = firstContentRawIdx()
  prevCursorLine = cursorLine
  const scrollable = findCodeScrollable()
  if (scrollable) scrollable.scrollY = 0
  updateHeader()
  updateFileTree()
  updateFooter()
  applyCommentColorsForCurrentFile()
}

const moveCursor = (delta: number) => {
  prevCursorLine = cursorLine
  cursorLine = nextContentRawIdx(cursorLine, delta > 0 ? 1 : -1)
  if (prevCursorLine !== cursorLine) {
    previewScrollOffset = 0
    paintLine(prevCursorLine)
    paintLine(cursorLine)
    ensureCursorVisible()
    updateHeader()
    updateFooter()
  }
}

const moveCursorWithShift = (delta: number) => {
  if (selectionAnchor === null) selectionAnchor = cursorLine
  prevCursorLine = cursorLine
  cursorLine = nextContentRawIdx(cursorLine, delta > 0 ? 1 : -1)
  if (prevCursorLine !== cursorLine) {
    paintLine(prevCursorLine)
    paintLine(cursorLine)
    ensureCursorVisible()
    updateHeader()
    updateFooter()
  }
}

const applyTheme = () => {
  const t = theme()
  diffRenderable.addedBg = RGBA.fromValues(0, 0, 0, 0)
  diffRenderable.removedBg = t.removedBg
  diffRenderable.contextBg = RGBA.fromValues(0, 0, 0, 0)
  diffRenderable.syntaxStyle = buildSyntaxStyle(t)
  headerText.fg = t.headerFg
  treeHeaderText.fg = focusedPanel === "tree" ? t.treeFocused : t.treeHeader
  treeHeaderText.backgroundColor = focusedPanel === "tree" ? t.headerBg : t.bg
  commentLabel.fg = t.commentMark
  commentInput.textColor = t.inputFg
  commentInput.backgroundColor = t.inputBg
  commentPreviewBox.backgroundColor = t.inputBg
  commentPreviewLabel.fg = t.commentMark
  commentPreviewLabel.backgroundColor = t.headerBg
  commentPreviewContent.fg = t.inputFg
  settingsModal.backgroundColor = t.bg
  settingsModal.borderColor = t.modalBorder
  modalTitle.fg = t.headerFg
  modalTitle.backgroundColor = t.headerBg
  modalThemeLabel.fg = t.mutedFg
  modalViewLabel.fg = t.mutedFg
  modalHint.fg = t.mutedFg
  exportModal.backgroundColor = t.bg
  exportModal.borderColor = t.modalBorder
  exportModalTitle.fg = t.headerFg
  exportModalTitle.backgroundColor = t.headerBg
  exportModalLabel.fg = t.mutedFg
  exportPromptInput.textColor = t.modalFg
  exportModalHint.fg = t.mutedFg
  themeSelect.backgroundColor = t.bg
  themeSelect.textColor = t.modalFg
  themeSelect.focusedBackgroundColor = t.addedBg
  viewSelect.backgroundColor = t.bg
  viewSelect.textColor = t.modalFg
  viewSelect.focusedBackgroundColor = t.addedBg
  footerPosition.fg = t.mutedFg
  updateFileTree()
  updateHeader()
  updateFooter()
  applyCommentColorsForCurrentFile()
}

const getRangeContent = (
  fd: FileDiff,
  startLine: number,
  endLine: number,
  side: "old" | "new" = "new",
): string => {
  const result: string[] = []
  let newCounter = 0
  let oldCounter = 0
  for (const l of fd.lines) {
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (m) {
        oldCounter = parseInt(m[1]!, 10)
        newCounter = parseInt(m[2]!, 10)
      }
    } else if (l.startsWith("+") && side === "new") {
      if (newCounter >= startLine && newCounter <= endLine)
        result.push(l.slice(1))
      if (newCounter > endLine) break
      newCounter++
    } else if (l.startsWith("-") && side === "old") {
      if (oldCounter >= startLine && oldCounter <= endLine)
        result.push(l.slice(1))
      if (oldCounter > endLine) break
      oldCounter++
    } else if (!l.startsWith("+") && !l.startsWith("-") && l) {
      const counter = side === "old" ? oldCounter : newCounter
      if (counter >= startLine && counter <= endLine) result.push(l.slice(1))
      if (counter > endLine) break
      newCounter++
      oldCounter++
    }
  }
  return result.join("\n")
}

const exportToMarkdown = async (prompt: string) => {
  if (comments.size === 0) {
    footerText.content = `  ✗ No comments to export`
    footerText.fg = theme().commentMark
    setTimeout(() => updateFooter(), 2000)
    return
  }
  const byFile = new Map<
    string,
    Array<{
      startLine: number
      endLine: number
      side: "old" | "new"
      comment: string
    }>
  >()
  for (const [key, comment] of comments) {
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
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file)!.push({ startLine, endLine, side, comment })
  }
  const reviewSections = [
    `# Code Review\n\nGenerated by revu on ${new Date().toISOString()}\n`,
  ]
  for (const [file, entries] of byFile) {
    reviewSections.push(`## \`${file}\`\n`)
    const fd = fileDiffs.find((f) => f.file === file)
    const ext = file.split(".").pop()?.toLowerCase() ?? ""
    for (const { startLine, endLine, side, comment } of entries.sort(
      (a, b) => a.startLine - b.startLine,
    )) {
      const content = fd ? getRangeContent(fd, startLine, endLine, side) : ""
      const codeBlock = content ? `\`\`\`${ext}\n${content}\n\`\`\`\n` : ""
      const sideLabel = side === "old" ? " (removed)" : ""
      const lineRef =
        startLine === endLine
          ? `Line ${startLine}${sideLabel}`
          : `Lines ${startLine}–${endLine}${sideLabel}`
      const commentText = comment
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")
      reviewSections.push(`### ${lineRef}\n${codeBlock}${commentText}\n`)
    }
  }
  const header = prompt.trim() ? `${prompt.trim()}\n\n---\n\n` : ""
  await Bun.write(EXPORT_PATH, header + reviewSections.join("\n"))
  footerText.content = `  ✓ Exported to revu-review.md`
  footerText.fg = theme().successFg
  setTimeout(() => updateFooter(), 3000)
}

// ── Comment flow ──────────────────────────────────────────────────────────────

const openCommentInput = () => {
  const sel = selectionRange()
  const startDiffLine = sel ? sel.start : cursorLine
  const endDiffLine = sel ? sel.end : cursorLine
  const startInfo = diffLineToFileLineNum(startDiffLine)
  if (startInfo == null) {
    footerText.content = `  ✗ Can't annotate this line (header)`
    footerText.fg = theme().commentMark
    setTimeout(() => updateFooter(), 2000)
    return
  }
  const endInfo = diffLineToFileLineNum(endDiffLine) ?? startInfo
  commentTargetLine = startInfo.lineNum
  commentTargetEndLine = endInfo.lineNum
  commentTargetSide = startInfo.side
  const isRange = commentTargetEndLine !== commentTargetLine
  const existing = comments.get(
    commentKey(
      currentFileDiff().file,
      commentTargetLine,
      isRange ? commentTargetEndLine : undefined,
      commentTargetSide,
    ),
  )
  const sideLabel = commentTargetSide === "old" ? " (removed)" : ""
  commentLabel.content = isRange
    ? `  ✎ Lines ${commentTargetLine}–${commentTargetEndLine}${sideLabel}:  `
    : `  ✎ Line ${commentTargetLine}${sideLabel}:  `
  commentInput.setText(existing ?? "")
  commentBarBox.visible = true
  commentInput.focus()
  mode = "comment"
  updateFooter()
}

const closeCommentBar = () => {
  commentBarBox.visible = false
  mode = "normal"
  commentInput.blur()
  commentInput.setText("")
  updateFooter()
}

commentInput.onSubmit = () => {
  const value = commentInput.plainText.trim()
  const isRange = commentTargetEndLine !== commentTargetLine
  const key = commentKey(
    currentFileDiff().file,
    commentTargetLine,
    isRange ? commentTargetEndLine : undefined,
    commentTargetSide,
  )
  if (value) {
    comments.set(key, value)
  } else {
    comments.delete(key)
  }
  selectionAnchor = null
  closeCommentBar()
  applyCommentColorsForCurrentFile()
  updateFileTree()
  updateHeader()
  saveComments()
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

renderer.keyInput.on("keypress", (e: KeyEvent) => {
  if (mode === "comment") {
    if (e.name === "escape") closeCommentBar()
    return
  }

  if (mode === "settings") {
    e.stopPropagation()
    if (e.name === "escape") {
      themeSelect.blur()
      viewSelect.blur()
      settingsModal.visible = false
      mode = "normal"
    } else if (e.name === "tab") {
      if (themeSelect.focused) {
        themeSelect.blur()
        viewSelect.focus()
      } else {
        viewSelect.blur()
        themeSelect.focus()
      }
    } else if (
      e.name === "return" ||
      e.name === "enter" ||
      e.sequence === "\r"
    ) {
      themeIndex = themeSelect.getSelectedIndex()
      diffView = viewSelect.getSelectedIndex() === 1 ? "split" : "unified"
      diffRenderable.view = diffView
      themeSelect.blur()
      viewSelect.blur()
      settingsModal.visible = false
      mode = "normal"
      applyTheme()
      saveSettings()
      updateFooter()
    } else if (viewSelect.focused) {
      viewSelect.handleKeyPress(e)
    } else {
      themeSelect.handleKeyPress(e)
    }
    return
  }

  if (mode === "export") {
    e.stopPropagation()
    if (e.name === "escape") {
      exportPromptInput.blur()
      exportModal.visible = false
      mode = "normal"
    } else if (
      e.name === "return" ||
      e.name === "enter" ||
      e.sequence === "\r"
    ) {
      const prompt = exportPromptInput.plainText.trim()
      exportPromptInput.blur()
      exportModal.visible = false
      mode = "normal"
      exportPromptInput.setText("")
      saveComments(prompt)
      exportToMarkdown(prompt)
    } else {
      exportPromptInput.handleKeyPress(e)
    }
    return
  }

  e.stopPropagation()

  if (focusedPanel === "tree") {
    if (e.name === "up" || e.name === "k") {
      if (fileIndex > 0) switchFile(fileIndex - 1)
    } else if (e.name === "down" || e.name === "j") {
      if (fileIndex < files.length - 1) switchFile(fileIndex + 1)
    } else if (
      e.name === "right" ||
      e.name === "return" ||
      e.name === "enter" ||
      e.sequence === "\r"
    ) {
      focusedPanel = "diff"
      updateFileTree()
      updateFooter()
    } else if (e.name === "s") {
      themeSelect.setSelectedIndex(themeIndex)
      viewSelect.setSelectedIndex(diffView === "split" ? 1 : 0)
      centerModal()
      settingsModal.visible = true
      themeSelect.focus()
      mode = "settings"
    } else if (e.name === "e" || e.name === "w") {
      if (comments.size === 0) {
        footerText.content = `  ✗ No comments to export`
        footerText.fg = theme().commentMark
        setTimeout(() => updateFooter(), 2000)
      } else {
        centerExportModal()
        exportModal.visible = true
        exportPromptInput.setText(savedPrompt)
        exportPromptInput.focus()
        mode = "export"
      }
    } else if (e.name === "q") {
      renderer.destroy()
      process.exit(0)
    }
    return
  }

  if (e.shift && e.name === "down") {
    moveCursorWithShift(+1)
  } else if (e.shift && e.name === "up") {
    moveCursorWithShift(-1)
  } else if (e.name === "j" || e.name === "down") {
    clearSelection()
    moveCursor(+1)
  } else if (e.name === "k" || e.name === "up") {
    clearSelection()
    moveCursor(-1)
  } else if (e.name === "escape") {
    clearSelection()
  } else if (e.name === "left" && !singleFile) {
    clearSelection()
    focusedPanel = "tree"
    updateFileTree()
    updateFooter()
  } else if (e.name === "return" || e.name === "enter" || e.sequence === "\r") {
    openCommentInput()
  } else if (e.name === "d") {
    const info = diffLineToFileLineNum(cursorLine)
    if (info != null) {
      const key = findCommentKeyForLine(
        currentFileDiff().file,
        info.lineNum,
        info.side,
      )
      if (key) {
        comments.delete(key)
        applyCommentColorsForCurrentFile()
        updateFileTree()
        updateHeader()
        saveComments()
      }
    }
  } else if (e.name === "}") {
    previewScrollOffset++
    updateCommentPreview()
  } else if (e.name === "{") {
    if (previewScrollOffset > 0) {
      previewScrollOffset--
      updateCommentPreview()
    }
  } else if (e.name === "]") {
    clearSelection()
    jumpToHunk(1)
  } else if (e.name === "[") {
    clearSelection()
    jumpToHunk(-1)
  } else if (e.name === "c") {
    clearSelection()
    jumpToComment(1)
  } else if (e.name === "C") {
    clearSelection()
    jumpToComment(-1)
  } else if (e.name === "n") {
    clearSelection()
    if (fileIndex < files.length - 1) switchFile(fileIndex + 1)
  } else if (e.name === "p") {
    clearSelection()
    if (fileIndex > 0) switchFile(fileIndex - 1)
  } else if (e.name === "s") {
    themeSelect.setSelectedIndex(themeIndex)
    viewSelect.setSelectedIndex(diffView === "split" ? 1 : 0)
    centerModal()
    settingsModal.visible = true
    themeSelect.focus()
    mode = "settings"
  } else if (e.name === "e" || e.name === "w") {
    if (comments.size === 0) {
      footerText.content = `  ✗ No comments to export`
      footerText.fg = theme().commentMark
      setTimeout(() => updateFooter(), 2000)
    } else {
      centerExportModal()
      exportModal.visible = true
      exportPromptInput.focus()
      mode = "export"
    }
  } else if (e.name === "q") {
    renderer.destroy()
    process.exit(0)
  }
})

// ── Init ──────────────────────────────────────────────────────────────────────

updateHeader()
updateTreeHeader()
updateFileTree()
updateFooter()
cursorLine = firstContentRawIdx()
prevCursorLine = cursorLine
applyCommentColorsForCurrentFile()
