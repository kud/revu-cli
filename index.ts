#!/usr/bin/env bun
import {
  createCliRenderer,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  TextRenderable,
  BoxRenderable,
  RGBA,
  SyntaxStyle,
  type KeyEvent,
} from "@opentui/core"

const targetDir = process.argv[2] ?? process.cwd()

const stagedOutput = await Bun.$`git diff --staged`.cwd(targetDir).text()
const fullDiff = stagedOutput.trim()
  ? stagedOutput
  : await Bun.$`git diff`.cwd(targetDir).text()

if (!fullDiff.trim()) {
  console.error("No diff found (neither staged nor unstaged changes).")
  process.exit(1)
}

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
    cursorBg: "#1e2540",
    selectionBg: "#2d3555",
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
    cursorBg: "#1e2a40",
    selectionBg: "#283457",
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
    cursorBg: "#2a3a48",
    selectionBg: "#374a60",
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
    cursorBg: "#1c2e4a",
    selectionBg: "#1f3a5f",
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
    cursorBg: "#373a50",
    selectionBg: "#44475a",
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
    cursorBg: "#2a2a40",
    selectionBg: "#313264",
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
    cursorBg: "#2a2e20",
    selectionBg: "#49483e",
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
    cursorBg: "#2a2a1e",
    selectionBg: "#3c4a28",
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
    cursorBg: "#221e36",
    selectionBg: "#2a2540",
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
    cursorBg: "#e8f0fe",
    selectionBg: "#c8d8f0",
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
const files = fileDiffs.map((f) => f.file)

// Comments: keyed "file:N" for single line, "file:N-M" for range (N < M)
const comments = new Map<string, string>()

const commentKey = (file: string, startLine: number, endLine?: number) =>
  endLine !== undefined && endLine !== startLine
    ? `${file}:${Math.min(startLine, endLine)}-${Math.max(startLine, endLine)}`
    : `${file}:${startLine}`

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
  try {
    const parsed = JSON.parse(Bun.file(SETTINGS_PATH).textSync())
    return {
      themeIndex:
        typeof parsed.themeIndex === "number"
          ? Math.min(parsed.themeIndex, THEMES.length - 1)
          : 0,
      diffView:
        parsed.diffView === "split" ? ("split" as const) : ("unified" as const),
    }
  } catch {
    return { themeIndex: 0, diffView: "unified" as const }
  }
}

const saveSettings = () =>
  Bun.write(SETTINGS_PATH, JSON.stringify({ themeIndex, diffView }, null, 2))

const saved = loadSettings()
let themeIndex = saved.themeIndex
let diffView: "unified" | "split" = saved.diffView

// ── App state ─────────────────────────────────────────────────────────────────

let fileIndex = 0
let cursorLine = 0
let prevCursorLine = 0
let selectionAnchor: number | null = null
let focusedPanel: "tree" | "diff" = "diff"
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
const TREE_WIDTH = 30

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

const fileListBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
})
const fileTextMap = new Map<string, TextRenderable>()
for (const file of files) {
  const label =
    file.length > TREE_WIDTH - 4 ? "…" + file.slice(-(TREE_WIDTH - 5)) : file
  const t = new TextRenderable(renderer, {
    content: `  ${label}`,
    width: "100%",
    height: 1,
  })
  t.fg = theme().treeInactive
  fileTextMap.set(file, t)
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
  addedBg: theme().addedBg,
  removedBg: theme().removedBg,
  contextBg: RGBA.fromValues(0, 0, 0, 0),
  syntaxStyle: buildSyntaxStyle(theme()),
})

mainArea.add(fileTreeBox)
mainArea.add(diffRenderable)

const commentBarBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  flexDirection: "row",
  backgroundColor: theme().inputBg,
  visible: false,
  alignItems: "center",
})
const commentLabel = new TextRenderable(renderer, { content: "" })
commentLabel.fg = theme().commentMark
const commentInput = new InputRenderable(renderer, { flexGrow: 1, value: "" })
commentInput.textColor = theme().inputFg
commentInput.backgroundColor = theme().inputBg

const footerBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  backgroundColor: theme().headerBg,
  alignItems: "center",
})
const footerText = new TextRenderable(renderer, { content: "", flexGrow: 1 })
footerText.fg = theme().mutedFg

const MODAL_W = 46
const settingsModal = new BoxRenderable(renderer, {
  width: MODAL_W,
  height: THEMES.length + 5,
  flexDirection: "column",
  backgroundColor: theme().modalBg,
  border: true,
  borderColor: theme().modalBorder,
  position: "absolute",
  visible: false,
  zIndex: 10,
})
settingsModal.setPosition({ top: 4, left: 18 })

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
  backgroundColor: theme().modalBg,
  textColor: theme().modalFg,
  focusedBackgroundColor: theme().addedBg,
  focusedTextColor: theme().modalFg,
})

const modalViewLabel = new TextRenderable(renderer, {
  content: "",
  width: "100%",
  height: 1,
})
modalViewLabel.fg = theme().mutedFg

const modalHint = new TextRenderable(renderer, {
  content: "  ↑↓ select · ↵ apply · v view · esc close",
  width: "100%",
  height: 1,
})
modalHint.fg = theme().mutedFg

settingsModal.add(modalTitle)
settingsModal.add(modalThemeLabel)
settingsModal.add(themeSelect)
settingsModal.add(modalViewLabel)
settingsModal.add(modalHint)

headerBox.add(headerText)
commentBarBox.add(commentLabel)
commentBarBox.add(commentInput)
footerBox.add(footerText)
rootBox.add(headerBox)
rootBox.add(mainArea)
rootBox.add(commentBarBox)
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
  const sy = scrollable.scrollY as number
  if (cursorLine < sy) {
    scrollable.scrollY = cursorLine
  } else if (cursorLine >= sy + viewH) {
    scrollable.scrollY = Math.max(0, cursorLine - viewH + 3)
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────

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

const paintLine = (i: number) => {
  const file = currentFileDiff().file
  const lineNum = diffLineToFileLineNum(i)
  const sel = selectionRange()
  const inSel = sel !== null && i >= sel.start && i <= sel.end
  if (i === cursorLine) {
    diffRenderable.setLineColor(i, theme().cursorBg)
  } else if (inSel) {
    diffRenderable.setLineColor(i, theme().selectionBg)
  } else if (lineNum !== null && isLineCommented(file, lineNum)) {
    diffRenderable.setLineColor(i, theme().commentedBg)
  } else {
    diffRenderable.clearLineColor(i)
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
  const sel = selectionRange()
  if (sel !== null) {
    const startLN = diffLineToFileLineNum(sel.start)
    const endLN = diffLineToFileLineNum(sel.end)
    const rangeStr =
      startLN !== null && endLN !== null
        ? `lines ${startLN}–${endLN}`
        : `${sel.end - sel.start + 1} lines`
    footerText.content = `  ⬚ ${rangeStr} selected  ·  ↵ comment  ·  esc cancel`
    footerText.fg = theme().headerFg
    return
  }
  const lineNum = diffLineToFileLineNum(cursorLine)
  const key =
    lineNum != null ? commentKey(currentFileDiff().file, lineNum) : null
  const comment = key ? comments.get(key) : undefined
  if (!comment && lineNum !== null) {
    const rangeKey = findCommentKeyForLine(currentFileDiff().file, lineNum)
    if (rangeKey) {
      footerText.content = `  ✎ ${rangeKey.split(":").slice(1).join(":")}: ${comments.get(rangeKey)}`
      footerText.fg = theme().commentMark
      return
    }
  }
  if (comment) {
    footerText.content = `  ✎ Line ${lineNum}: ${comment}`
    footerText.fg = theme().commentMark
  } else if (focusedPanel === "tree") {
    footerText.content = `  ↑↓ navigate files  ·  → or ↵ focus diff  ·  s settings  ·  e export  ·  q quit`
    footerText.fg = theme().mutedFg
  } else {
    footerText.content = `  ↑↓/jk move  ·  ⇧↑↓ select  ·  ↵ comment  ·  d delete  ·  ← files  ·  e export  ·  s settings  ·  q quit`
    footerText.fg = theme().mutedFg
  }
}

const updateHeader = () => {
  const count = comments.size
  const file = currentFileDiff().file
  const shortFile = file.length > 40 ? "…" + file.slice(-39) : file
  headerText.content = `  revu  ·  ${shortFile}  ·  ${count} ${count === 1 ? "comment" : "comments"}`
  headerText.fg = theme().headerFg
}

const updateFileTree = () => {
  const t = theme()
  for (const [file, text] of fileTextMap) {
    const hasComments = [...comments.keys()].some((k) =>
      k.startsWith(`${file}:`),
    )
    const isActive = files[fileIndex] === file
    const label =
      file.length > TREE_WIDTH - 4 ? "…" + file.slice(-(TREE_WIDTH - 5)) : file
    const isFocusedActive = isActive && focusedPanel === "tree"
    const prefix = isFocusedActive ? "❯ " : isActive ? "▶ " : "  "
    text.content = `${prefix}${label}${hasComments ? " ●" : ""}`
    text.fg = isFocusedActive
      ? t.treeFocused
      : isActive
        ? t.treeActive
        : hasComments
          ? t.treeComment
          : t.treeInactive
  }
}

const applyCommentColorsForCurrentFile = () => {
  const file = currentFileDiff().file
  const lines = currentFileDiff().lines
  const sel = selectionRange()
  let counter = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("@@ ")) {
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      counter = m ? parseInt(m[1]!, 10) : counter
      diffRenderable.clearLineColor(i)
    } else {
      const inSel = sel !== null && i >= sel.start && i <= sel.end
      const lineNum = l.startsWith("-")
        ? null
        : l.startsWith("+")
          ? counter
          : l
            ? counter
            : null
      if (i === cursorLine) {
        diffRenderable.setLineColor(i, theme().cursorBg)
      } else if (inSel) {
        diffRenderable.setLineColor(i, theme().selectionBg)
      } else if (lineNum !== null && isLineCommented(file, lineNum)) {
        diffRenderable.setLineColor(i, theme().commentedBg)
      } else {
        diffRenderable.clearLineColor(i)
      }
      if (!l.startsWith("-") && !l.startsWith("@@ ") && l) counter++
    }
  }
  updateFooter()
}

const switchFile = (idx: number) => {
  selectionAnchor = null
  fileIndex = idx
  cursorLine = 0
  prevCursorLine = 0
  diffRenderable.diff = currentFileDiff().raw
  diffRenderable.filetype = getFiletype(currentFileDiff().file)
  updateHeader()
  updateFileTree()
  updateFooter()
  setTimeout(() => {
    const scrollable = findCodeScrollable()
    if (scrollable) scrollable.scrollY = 0
    applyCommentColorsForCurrentFile()
  }, 50)
}

const moveCursor = (delta: number) => {
  prevCursorLine = cursorLine
  cursorLine = Math.max(0, Math.min(fileLineCount() - 1, cursorLine + delta))
  if (prevCursorLine !== cursorLine) {
    paintLine(prevCursorLine)
    paintLine(cursorLine)
    ensureCursorVisible()
    updateFooter()
  }
}

const moveCursorWithShift = (delta: number) => {
  if (selectionAnchor === null) selectionAnchor = cursorLine
  prevCursorLine = cursorLine
  cursorLine = Math.max(0, Math.min(fileLineCount() - 1, cursorLine + delta))
  if (prevCursorLine !== cursorLine) {
    paintLine(prevCursorLine)
    paintLine(cursorLine)
    ensureCursorVisible()
    updateFooter()
  }
}

const applyTheme = () => {
  const t = theme()
  diffRenderable.addedBg = t.addedBg
  diffRenderable.removedBg = t.removedBg
  diffRenderable.contextBg = RGBA.fromValues(0, 0, 0, 0)
  diffRenderable.syntaxStyle = buildSyntaxStyle(t)
  headerText.fg = t.headerFg
  treeHeaderText.fg = t.treeHeader
  treeHeaderText.backgroundColor = t.headerBg
  commentLabel.fg = t.commentMark
  commentInput.textColor = t.inputFg
  commentInput.backgroundColor = t.inputBg
  modalTitle.fg = t.headerFg
  modalTitle.backgroundColor = t.headerBg
  modalThemeLabel.fg = t.mutedFg
  modalViewLabel.fg = t.mutedFg
  modalHint.fg = t.mutedFg
  themeSelect.backgroundColor = t.modalBg
  themeSelect.textColor = t.modalFg
  themeSelect.focusedBackgroundColor = t.addedBg
  updateFileTree()
  updateHeader()
  updateFooter()
  setTimeout(() => applyCommentColorsForCurrentFile(), 50)
}

const updateModalViewLabel = () => {
  modalViewLabel.content = `  View: ${diffView === "unified" ? "● unified  ○ split" : "○ unified  ● split"}`
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
  await Bun.write(`${targetDir}/revu-output.md`, sections.join("\n"))
  footerText.content = `  ✓ Exported to revu-output.md`
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
  commentInput.value = existing ?? ""
  commentBarBox.visible = true
  commentInput.focus()
  mode = "comment"
}

const closeCommentBar = () => {
  commentBarBox.visible = false
  mode = "normal"
  commentInput.blur()
  commentInput.value = ""
}

commentInput.on(InputRenderableEvents.ENTER, () => {
  const value = commentInput.value.trim()
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
})

// ── Keyboard ──────────────────────────────────────────────────────────────────

renderer.keyInput.on("keypress", (e: KeyEvent) => {
  if (mode === "comment") {
    if (e.name === "escape") closeCommentBar()
    return
  }

  if (mode === "settings") {
    e.stopPropagation()
    if (e.name === "escape") {
      settingsModal.visible = false
      mode = "normal"
      themeSelect.blur()
    } else if (
      e.name === "return" ||
      e.name === "enter" ||
      e.sequence === "\r"
    ) {
      themeIndex = themeSelect.getSelectedIndex()
      applyTheme()
      saveSettings()
      settingsModal.visible = false
      mode = "normal"
      themeSelect.blur()
    } else if (e.name === "v") {
      diffView = diffView === "unified" ? "split" : "unified"
      diffRenderable.view = diffView
      saveSettings()
      updateModalViewLabel()
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
      updateModalViewLabel()
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
  } else if (e.name === "left") {
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
  } else if (e.name === "n") {
    clearSelection()
    if (fileIndex < files.length - 1) switchFile(fileIndex + 1)
  } else if (e.name === "p") {
    clearSelection()
    if (fileIndex > 0) switchFile(fileIndex - 1)
  } else if (e.name === "s") {
    themeSelect.setSelectedIndex(themeIndex)
    updateModalViewLabel()
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
updateFileTree()
updateFooter()
setTimeout(() => applyCommentColorsForCurrentFile(), 100)
