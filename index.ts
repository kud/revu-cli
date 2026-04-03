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
  ] [                           Jump to next / prev hunk
  c C                           Jump to next / prev annotation
  e                             Export annotations to revu-output.md
  s                             Settings (theme, view)
  q                             Quit

Config:
  revu.json in the target repo  { "outputFilename": "my-review.md" }`)
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

interface RevuConfig {
  outputFilename?: string
}

const loadConfig = async (): Promise<RevuConfig> => {
  const configPath = `${targetDir}/revu.json`
  try {
    const file = Bun.file(configPath)
    if (await file.exists()) return (await file.json()) as RevuConfig
  } catch {}
  return {}
}

const revuConfig = await loadConfig()
const rawOutputFilename = revuConfig.outputFilename ?? "revu-output.md"
let outputFilename = rawOutputFilename.endsWith(".md")
  ? rawOutputFilename
  : `${rawOutputFilename}.md`

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
    const fileMatch = block.match(/^\+\+\+ b\/(.+)$/m)
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

const commentKey = (file: string, startLine: number, endLine?: number) =>
  endLine !== undefined && endLine !== startLine
    ? `${file}:${Math.min(startLine, endLine)}-${Math.max(startLine, endLine)}`
    : `${file}:${startLine}`

const loadCommentsFromExport = async (): Promise<void> => {
  const exportFile = Bun.file(`${targetDir}/${outputFilename}`)
  if (!(await exportFile.exists())) return
  const lines = (await exportFile.text()).split("\n")
  let currentFile = ""
  let startLine = 0
  let endLine = 0
  let commentLines: string[] = []
  const flush = () => {
    if (currentFile && startLine > 0 && commentLines.length > 0) {
      const key = commentKey(
        currentFile,
        startLine,
        endLine !== startLine ? endLine : undefined,
      )
      comments.set(key, commentLines.join("\n").trim())
    }
    commentLines = []
  }
  for (const line of lines) {
    if (line.startsWith("## `") && line.endsWith("`")) {
      flush()
      currentFile = line.slice(4, -1)
      startLine = 0
      endLine = 0
    } else if (line.startsWith("### Lines ")) {
      flush()
      const [s, e] = line.slice(10).split("–")
      startLine = parseInt(s!, 10)
      endLine = parseInt(e!, 10)
    } else if (line.startsWith("### Line ")) {
      flush()
      startLine = parseInt(line.slice(9), 10)
      endLine = startLine
    } else if (line.startsWith("> ")) {
      commentLines.push(line.slice(2))
    } else if (
      commentLines.length > 0 &&
      line !== "" &&
      !line.startsWith("#") &&
      !line.startsWith("```")
    ) {
      commentLines.push(line)
    }
  }
  flush()
}

await loadCommentsFromExport()

const isLineCommented = (file: string, lineNum: number): boolean => {
  for (const key of comments.keys()) {
    if (!key.startsWith(`${file}:`)) continue
    const rest = key.slice(file.length + 1)
    const dash = rest.indexOf("-")
    if (dash === -1) {
      if (parseInt(rest, 10) === lineNum) return true
    } else {
      const s = parseInt(rest.slice(0, dash), 10)
      const e = parseInt(rest.slice(dash + 1), 10)
      if (lineNum >= s && lineNum <= e) return true
    }
  }
  return false
}

const findCommentKeyForLine = (
  file: string,
  lineNum: number,
): string | null => {
  for (const key of comments.keys()) {
    if (!key.startsWith(`${file}:`)) continue
    const rest = key.slice(file.length + 1)
    const dash = rest.indexOf("-")
    if (dash === -1) {
      if (parseInt(rest, 10) === lineNum) return key
    } else {
      const s = parseInt(rest.slice(0, dash), 10)
      const e = parseInt(rest.slice(dash + 1), 10)
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
  const merged = { ...global, ...revuConfig }
  return {
    themeIndex:
      typeof merged.themeIndex === "number"
        ? Math.min(merged.themeIndex, THEMES.length - 1)
        : 0,
    diffView:
      merged.diffView === "split" ? ("split" as const) : ("unified" as const),
  }
}

const saveSettings = async () => {
  const updated = { ...revuConfig, themeIndex, diffView, outputFilename }
  await Bun.write(
    `${targetDir}/revu.json`,
    JSON.stringify(updated, null, 2) + "\n",
  )
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
type Mode = "normal" | "comment" | "settings"
let mode: Mode = "normal"
let commentTargetLine = 0
let commentTargetEndLine = 0

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
const MODAL_H = THEMES.length + 9
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

const modalOutputLabel = new TextRenderable(renderer, {
  content: "  Output file",
  width: "100%",
  height: 1,
})
modalOutputLabel.fg = theme().mutedFg

const modalOutputInput = new TextareaRenderable(renderer, {
  width: "100%",
  height: 1,
  paddingLeft: 2,
})
modalOutputInput.textColor = theme().modalFg
modalOutputInput.backgroundColor = RGBA.fromValues(0, 0, 0, 0)
modalOutputInput.setText(outputFilename)

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
settingsModal.add(modalOutputLabel)
settingsModal.add(modalOutputInput)
settingsModal.add(modalHint)

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

const diffLineToFileLineNum = (lineIdx: number): number | null => {
  const lines = currentFileDiff().lines
  let counter = 0
  for (let i = 0; i <= lineIdx && i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      counter = m ? parseInt(m[1]!, 10) : counter
    } else if (l.startsWith("+")) {
      if (i === lineIdx) return counter
      counter++
    } else if (!l.startsWith("-")) {
      if (i === lineIdx) return counter
      if (l) counter++
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
  const lineNum = diffLineToFileLineNum(rawIdx)
  const sel = selectionRange()
  const inSel = sel !== null && rawIdx >= sel.start && rawIdx <= sel.end
  if (rawIdx === cursorLine) {
    diffRenderable.setLineColor(contentIdx, theme().cursorBg)
  } else if (inSel) {
    diffRenderable.setLineColor(contentIdx, theme().selectionBg)
  } else if (lineNum !== null && isLineCommented(file, lineNum)) {
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
  const sep = dim("  ·  ")
  footerPosition.content = ""
  if (mode === "comment") {
    footerText.content = t`  ${hi("⌥↵")} ${dim("submit")}${sep}${hi("esc")} ${dim("cancel")}`
    footerText.fg = theme().mutedFg
    return
  }
  const sel = selectionRange()
  if (sel !== null) {
    const startLN = diffLineToFileLineNum(sel.start)
    const endLN = diffLineToFileLineNum(sel.end)
    const rangeStr =
      startLN !== null && endLN !== null
        ? `lines ${startLN}–${endLN}`
        : `${sel.end - sel.start + 1} lines`
    footerText.content = t`  ⬚ ${dim(`${rangeStr} selected`)}${sep}${hi("↵")} ${dim("annotate")}${sep}${hi("esc")} ${dim("cancel")}`
    footerText.fg = theme().headerFg
    return
  }
  if (focusedPanel === "tree") {
    footerText.content = t`  ${hi("↑↓")} ${dim("files")}${sep}${hi("↵")} ${dim("open")}${sep}${hi("e")} ${dim(`export → ${outputFilename}`)}${sep}${hi("s")} ${dim("settings")}${sep}${hi("q")} ${dim("quit")}`
  } else {
    footerText.content = t`  ${hi("↑↓")} ${dim("move")}${sep}${hi("shift+↑↓")} ${dim("select")}${sep}${hi("↵")} ${dim("annotate")}${sep}${hi("e")} ${dim(`export → ${outputFilename}`)}${sep}${hi("q")} ${dim("quit")}`
  }
  footerText.fg = theme().mutedFg
}

const updateCommentPreview = () => {
  if (mode !== "normal" || focusedPanel !== "diff") {
    commentPreviewBox.visible = false
    return
  }
  const lineNum = diffLineToFileLineNum(cursorLine)
  if (lineNum === null) {
    commentPreviewBox.visible = false
    return
  }
  const file = currentFileDiff().file
  const key =
    findCommentKeyForLine(file, lineNum) ??
    (comments.has(commentKey(file, lineNum)) ? commentKey(file, lineNum) : null)
  const comment = key ? comments.get(key) : null
  if (!comment) {
    commentPreviewBox.visible = false
    return
  }
  const parts = key!.split(":")
  const lineRef = parts.slice(1).join(":")
  const lineLabel = lineRef.includes("-")
    ? `lines ${lineRef}`
    : `line ${lineRef}`
  const commentLines = comment.split("\n")
  const MAX_PREVIEW = 4
  const truncated = commentLines.length > MAX_PREVIEW
  const visibleLines = truncated
    ? commentLines.slice(0, MAX_PREVIEW)
    : commentLines
  const moreIndicator = truncated
    ? dim(`  +${commentLines.length - MAX_PREVIEW} more`)
    : ""
  commentPreviewLabel.content = t`  ${fg(theme().commentMark)("▌")} ${fg(theme().commentMark)(lineLabel)}  ${dim("↵ edit  d delete")}${moreIndicator}`
  commentPreviewContent.content = visibleLines
    .map((l) => `  ▌  ${l}`)
    .join("\n")
  commentPreviewBox.height = Math.min(visibleLines.length + 1, 6)
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
  headerText.content = `  revu  ·  ${modeStr}${shortFile}${posStr}  ·  ${count} ${count === 1 ? "note" : "notes"}`
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
  let counter = 0
  let contentIdx = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      counter = m ? parseInt(m[1]!, 10) : counter
    } else if (isContentLine(l)) {
      const inSel = sel !== null && i >= sel.start && i <= sel.end
      const lineNum = l.startsWith("-") ? null : counter
      if (i === cursorLine) {
        diffRenderable.setLineColor(contentIdx, theme().cursorBg)
      } else if (inSel) {
        diffRenderable.setLineColor(contentIdx, theme().selectionBg)
      } else if (lineNum !== null && isLineCommented(file, lineNum)) {
        diffRenderable.setLineColor(contentIdx, theme().commentedBg)
      } else {
        diffRenderable.clearLineColor(contentIdx)
      }
      if (!l.startsWith("-")) counter++
      contentIdx++
    }
  }
  updateFooter()
}

const switchFile = (idx: number) => {
  selectionAnchor = null
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
  modalOutputLabel.fg = t.mutedFg
  modalOutputInput.textColor = t.modalFg
  modalHint.fg = t.mutedFg
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
): string => {
  const result: string[] = []
  let counter = 0
  for (const l of fd.lines) {
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      counter = m ? parseInt(m[1]!, 10) : counter
    } else if (l.startsWith("+")) {
      if (counter >= startLine && counter <= endLine) result.push(l.slice(1))
      if (counter > endLine) break
      counter++
    } else if (!l.startsWith("-") && l) {
      if (counter >= startLine && counter <= endLine) result.push(l.slice(1))
      if (counter > endLine) break
      counter++
    }
  }
  return result.join("\n")
}

const exportComments = async () => {
  if (comments.size === 0) {
    footerText.content = `  ✗ No comments to export`
    footerText.fg = theme().commentMark
    setTimeout(() => updateFooter(), 2000)
    return
  }
  const byFile = new Map<
    string,
    Array<{ startLine: number; endLine: number; comment: string }>
  >()
  for (const [key, comment] of comments) {
    const colonIdx = key.indexOf(":")
    const file = key.slice(0, colonIdx)
    const rest = key.slice(colonIdx + 1)
    const dash = rest.indexOf("-")
    const startLine =
      dash === -1 ? parseInt(rest, 10) : parseInt(rest.slice(0, dash), 10)
    const endLine = dash === -1 ? startLine : parseInt(rest.slice(dash + 1), 10)
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file)!.push({ startLine, endLine, comment })
  }
  const sections = [
    `# Code Review\n\nGenerated by revu on ${new Date().toISOString()}\n`,
  ]
  for (const [file, entries] of byFile) {
    sections.push(`## \`${file}\`\n`)
    const fd = fileDiffs.find((f) => f.file === file)
    const ext = file.split(".").pop()?.toLowerCase() ?? ""
    for (const { startLine, endLine, comment } of entries.sort(
      (a, b) => a.startLine - b.startLine,
    )) {
      const content = fd ? getRangeContent(fd, startLine, endLine) : ""
      const codeBlock = content ? `\`\`\`${ext}\n${content}\n\`\`\`\n` : ""
      const lineRef =
        startLine === endLine
          ? `Line ${startLine}`
          : `Lines ${startLine}–${endLine}`
      sections.push(`### ${lineRef}\n${codeBlock}> ${comment}\n`)
    }
  }
  await Bun.write(`${targetDir}/${outputFilename}`, sections.join("\n"))
  footerText.content = `  ✓ Exported to ${outputFilename}`
  footerText.fg = theme().successFg
  setTimeout(() => updateFooter(), 3000)
}

// ── Comment flow ──────────────────────────────────────────────────────────────

const openCommentInput = () => {
  const sel = selectionRange()
  const startDiffLine = sel ? sel.start : cursorLine
  const endDiffLine = sel ? sel.end : cursorLine
  const startLineNum = diffLineToFileLineNum(startDiffLine)
  if (startLineNum == null) {
    footerText.content = `  ✗ Can't comment on this line (header/hunk)`
    footerText.fg = theme().commentMark
    setTimeout(() => updateFooter(), 2000)
    return
  }
  const endLineNum = diffLineToFileLineNum(endDiffLine) ?? startLineNum
  commentTargetLine = startLineNum
  commentTargetEndLine = endLineNum
  const isRange = commentTargetEndLine !== commentTargetLine
  const existing = comments.get(
    commentKey(
      currentFileDiff().file,
      commentTargetLine,
      isRange ? commentTargetEndLine : undefined,
    ),
  )
  commentLabel.content = isRange
    ? `  ✎ Lines ${commentTargetLine}–${commentTargetEndLine}:  `
    : `  ✎ Line ${commentTargetLine}:  `
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
      modalOutputInput.blur()
      settingsModal.visible = false
      mode = "normal"
    } else if (e.name === "tab") {
      if (themeSelect.focused) {
        themeSelect.blur()
        viewSelect.focus()
      } else if (viewSelect.focused) {
        viewSelect.blur()
        modalOutputInput.focus()
      } else {
        modalOutputInput.blur()
        themeSelect.focus()
      }
    } else if (
      e.name === "return" ||
      e.name === "enter" ||
      e.sequence === "\r"
    ) {
      if (modalOutputInput.focused) {
        const raw = modalOutputInput.plainText.trim()
        if (raw) {
          outputFilename = raw.endsWith(".md") ? raw : `${raw}.md`
          modalOutputInput.setText(outputFilename)
        }
        modalOutputInput.blur()
        themeSelect.focus()
      } else {
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
      }
    } else if (modalOutputInput.focused) {
      modalOutputInput.handleKeyPress(e)
    } else if (viewSelect.focused) {
      viewSelect.handleKeyPress(e)
    } else {
      themeSelect.handleKeyPress(e)
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
      exportComments()
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
    const lineNum = diffLineToFileLineNum(cursorLine)
    if (lineNum != null) {
      const key = findCommentKeyForLine(currentFileDiff().file, lineNum)
      if (key) {
        comments.delete(key)
        applyCommentColorsForCurrentFile()
        updateFileTree()
        updateHeader()
      }
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
    settingsModal.visible = true
    themeSelect.focus()
    mode = "settings"
  } else if (e.name === "e" || e.name === "w") {
    exportComments()
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
