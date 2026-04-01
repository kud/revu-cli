#!/usr/bin/env bun
import {
  createCliRenderer,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  BoxRenderable,
  RGBA,
  SyntaxStyle,
  type KeyEvent,
} from "@opentui/core"

const targetDir = process.argv[2] ?? process.cwd()

const stagedOutput = await Bun.$`git diff --staged`.cwd(targetDir).text()
const diff = stagedOutput.trim()
  ? stagedOutput
  : await Bun.$`git diff`.cwd(targetDir).text()

if (!diff.trim()) {
  console.error("No diff found (neither staged nor unstaged changes).")
  process.exit(1)
}

type DiffLineType = "header" | "hunk" | "add" | "remove" | "context"

interface DiffLine {
  raw: string
  file: string
  newLineNumber: number | null
  type: DiffLineType
}

const parseDiffLines = (rawDiff: string): DiffLine[] => {
  const lines = rawDiff.split("\n")
  const result: DiffLine[] = []
  let currentFile = ""
  let newLineCounter = 0

  for (const raw of lines) {
    if (raw.startsWith("+++ b/")) {
      currentFile = raw.slice(6)
      result.push({
        raw,
        file: currentFile,
        newLineNumber: null,
        type: "header",
      })
    } else if (
      raw.startsWith("diff --git") ||
      raw.startsWith("--- ") ||
      raw.startsWith("index ")
    ) {
      result.push({
        raw,
        file: currentFile,
        newLineNumber: null,
        type: "header",
      })
    } else if (raw.startsWith("@@ ")) {
      const match = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      newLineCounter = match ? parseInt(match[1] ?? "0", 10) : 0
      result.push({ raw, file: currentFile, newLineNumber: null, type: "hunk" })
    } else if (raw.startsWith("+")) {
      result.push({
        raw,
        file: currentFile,
        newLineNumber: newLineCounter++,
        type: "add",
      })
    } else if (raw.startsWith("-")) {
      result.push({
        raw,
        file: currentFile,
        newLineNumber: null,
        type: "remove",
      })
    } else {
      result.push({
        raw,
        file: currentFile,
        newLineNumber: raw ? newLineCounter++ : null,
        type: "context",
      })
    }
  }

  return result
}

const diffLines = parseDiffLines(diff)
const totalLines = diffLines.length

let cursorLine = 0
const comments = new Map<number, string>()
let mode: "normal" | "input" = "normal"
let pendingCommentLine = 0

const COLORS = {
  bg: "#0d1117",
  headerBg: "#161b22",
  footerBg: "#161b22",
  headerFg: "#58a6ff",
  accent: "#79c0ff",
  cursor: "#1f6feb",
  commented: "#3d2b00",
  commentMark: "#e3b341",
  inputBg: "#161b22",
  inputFg: "#c9d1d9",
  inputBorder: "#30363d",
  mutedFg: "#8b949e",
  successFg: "#3fb950",
  addedBg: "#0d4429",
  removedBg: "#67060c",
  contextBg: "#0d1117",
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  backgroundColor: COLORS.bg,
})

const rootBox = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  backgroundColor: COLORS.bg,
})

const headerBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  backgroundColor: COLORS.headerBg,
  alignItems: "center",
})

const headerText = new TextRenderable(renderer, {
  content: "",
  flexGrow: 1,
})
headerText.fg = COLORS.headerFg

const diffRenderable = new DiffRenderable(renderer, {
  diff,
  view: "unified",
  showLineNumbers: true,
  flexGrow: 1,
  addedBg: COLORS.addedBg,
  removedBg: COLORS.removedBg,
  contextBg: COLORS.contextBg,
  syntaxStyle: SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex("#c9d1d9") },
    string: { fg: RGBA.fromHex("#a5d6ff") },
    keyword: { fg: RGBA.fromHex("#ff7b72"), bold: true },
    comment: { fg: RGBA.fromHex("#8b949e"), italic: true },
    number: { fg: RGBA.fromHex("#79c0ff") },
    function: { fg: RGBA.fromHex("#d2a8ff") },
    operator: { fg: RGBA.fromHex("#ff7b72") },
    type: { fg: RGBA.fromHex("#ffa657") },
  }),
})

const commentBarBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  flexDirection: "row",
  backgroundColor: COLORS.inputBg,
  visible: false,
  alignItems: "center",
})

const commentLabelText = new TextRenderable(renderer, {
  content: "  ✎ Comment on line 0:  ",
})
commentLabelText.fg = COLORS.commentMark

const commentInput = new InputRenderable(renderer, {
  flexGrow: 1,
  value: "",
})
commentInput.textColor = COLORS.inputFg
commentInput.backgroundColor = COLORS.inputBg

const footerBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  backgroundColor: COLORS.footerBg,
  alignItems: "center",
})

const footerText = new TextRenderable(renderer, {
  content:
    "  ↑↓ / jk  navigate  ·  c  comment  ·  d  delete  ·  e  export  ·  q  quit",
  flexGrow: 1,
})
footerText.fg = COLORS.mutedFg

headerBox.add(headerText)
commentBarBox.add(commentLabelText)
commentBarBox.add(commentInput)
footerBox.add(footerText)

rootBox.add(headerBox)
rootBox.add(diffRenderable)
rootBox.add(commentBarBox)
rootBox.add(footerBox)

renderer.root.add(rootBox)

const updateHeader = () => {
  const commentCount = comments.size
  const commentSuffix = commentCount === 1 ? "comment" : "comments"
  headerText.content = `  revu  ·  ${targetDir}  ·  ${totalLines} lines, ${commentCount} ${commentSuffix}`
}

const refreshLineColors = () => {
  for (let i = 0; i < totalLines; i++) {
    if (comments.has(i)) {
      diffRenderable.setLineColor(i, COLORS.commented)
    } else {
      diffRenderable.clearLineColor(i)
    }
  }
  diffRenderable.highlightLines(cursorLine, cursorLine, COLORS.cursor)
}

const moveCursor = (delta: number) => {
  cursorLine = Math.max(0, Math.min(totalLines - 1, cursorLine + delta))
  refreshLineColors()
}

const exportComments = async () => {
  const byFile = new Map<
    string,
    Array<{ lineNumber: number | null; lineIndex: number; comment: string }>
  >()

  for (const [lineIndex, comment] of comments) {
    const line = diffLines[lineIndex]
    const file = line?.file ?? "unknown"
    if (!byFile.has(file)) byFile.set(file, [])
    byFile
      .get(file)!
      .push({ lineNumber: line?.newLineNumber ?? null, lineIndex, comment })
  }

  const sections: string[] = [
    `# Code Review\n\nGenerated by revu on ${new Date().toISOString()}\n`,
  ]

  for (const [file, entries] of byFile) {
    sections.push(`## \`${file}\`\n`)
    for (const { lineNumber, lineIndex, comment } of entries) {
      const lineLabel =
        lineNumber !== null ? `Line ${lineNumber}` : `Diff line ${lineIndex}`
      const rawLine = diffLines[lineIndex]?.raw ?? ""
      sections.push(
        `### ${lineLabel}\n\`\`\`\n${rawLine}\n\`\`\`\n> ${comment}\n`,
      )
    }
  }

  const outputPath = `${targetDir}/revu-output.md`
  await Bun.write(outputPath, sections.join("\n"))
  footerText.content = `  ✓ Exported to revu-output.md`
  footerText.fg = COLORS.successFg
}

refreshLineColors()
updateHeader()

renderer.keyInput.on("keypress", (e: KeyEvent) => {
  if (mode === "input") {
    if (e.name === "escape") {
      commentBarBox.visible = false
      mode = "normal"
      commentInput.blur()
    }
    return
  }

  if (e.name === "j" || e.name === "down") {
    moveCursor(+1)
  } else if (e.name === "k" || e.name === "up") {
    moveCursor(-1)
  } else if (e.name === "c") {
    pendingCommentLine = cursorLine
    commentLabelText.content = `  ✎ Comment on line ${cursorLine}:  `
    commentInput.value = comments.get(cursorLine) ?? ""
    commentBarBox.visible = true
    commentInput.focus()
    mode = "input"
  } else if (e.name === "d") {
    comments.delete(cursorLine)
    refreshLineColors()
    updateHeader()
  } else if (e.name === "e" || e.name === "w") {
    exportComments()
  } else if (e.name === "q") {
    process.exit(0)
  }
})

commentInput.on(InputRenderableEvents.ENTER, () => {
  const value = commentInput.value.trim()
  if (value) {
    comments.set(pendingCommentLine, value)
  }
  commentInput.value = ""
  commentBarBox.visible = false
  mode = "normal"
  commentInput.blur()
  refreshLineColors()
  updateHeader()
})
