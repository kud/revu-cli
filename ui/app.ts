// The interactive TUI. `runApp` receives the resolved review data and owns the
// renderer plus all ephemeral UI state (cursor, selection, mode). The large
// body below is the original single-file TUI kept intact to preserve behaviour;
// shared logic (diff math, model, export, themes, settings, splash) was lifted
// into sibling modules and is bound to the live mutable state via the thin
// wrappers near the top.

import {
  createCliRenderer,
  DiffRenderable,
  TextareaRenderable,
  SelectRenderable,
  TextRenderable,
  BoxRenderable,
  RGBA,
  getTreeSitterClient,
  type KeyEvent,
  t,
  fg,
  dim,
  StyledText,
} from "@opentui/core"
import {
  type FileDiff,
  getFiletype,
  isContentLine,
  rawToContentIdx as rawToContentIdxIn,
  nextContentRawIdx as nextContentRawIdxIn,
  firstContentRawIdx as firstContentRawIdxIn,
  totalContentLines as totalContentLinesIn,
  diffLineToFileLineNum as diffLineToFileLineNumIn,
} from "../git.ts"
import {
  commentKey,
  isLineCommented as isLineCommentedIn,
  findCommentKeyForLine as findCommentKeyForLineIn,
  saveComments as saveCommentsFile,
} from "../model.ts"
import { buildReviewMarkdown } from "../export.ts"
import { type Theme, THEMES, buildSyntaxStyle } from "./themes.ts"
import { saveSettings as saveSettingsFile } from "./settings.ts"
import { showSplash } from "./splash.ts"

export interface AppContext {
  fileDiffs: FileDiff[]
  files: string[]
  prMode: boolean
  currentBranch: string | null
  againstBranch: string | null
  commitList: string[]
  comments: Map<string, string>
  savedPrompt: string
  themeIndex: number
  diffView: "unified" | "split"
  autosavePath: string
  exportPath: string
}

export const runApp = async (ctx: AppContext) => {
  const {
    fileDiffs,
    files,
    prMode,
    currentBranch,
    againstBranch,
    commitList,
    comments,
  } = ctx
  let { themeIndex, diffView, savedPrompt } = ctx
  const AUTOSAVE_PATH = ctx.autosavePath
  const EXPORT_PATH = ctx.exportPath

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

  const theme = () => THEMES[themeIndex]!
  const currentFileDiff = () => fileDiffs[fileIndex]!
  const TREE_WIDTH = 38

  // ── Bindings: shared module helpers bound to this run's mutable state ────────

  const isLineCommented = (
    file: string,
    lineNum: number,
    side: "old" | "new" = "new",
  ): boolean => isLineCommentedIn(comments, file, lineNum, side)

  const findCommentKeyForLine = (
    file: string,
    lineNum: number,
    side: "old" | "new" = "new",
  ): string | null => findCommentKeyForLineIn(comments, file, lineNum, side)

  const saveComments = async (prompt?: string): Promise<void> => {
    if (prompt !== undefined) savedPrompt = prompt
    await saveCommentsFile(AUTOSAVE_PATH, comments, savedPrompt)
  }

  const saveSettings = async (): Promise<void> => {
    await saveSettingsFile({ themeIndex, diffView })
  }

  const rawToContentIdx = (rawIdx: number): number =>
    rawToContentIdxIn(currentFileDiff().lines, rawIdx)

  const nextContentRawIdx = (rawIdx: number, dir: 1 | -1): number =>
    nextContentRawIdxIn(currentFileDiff().lines, rawIdx, dir)

  const firstContentRawIdx = (): number =>
    firstContentRawIdxIn(currentFileDiff().lines)

  const totalContentLines = (): number =>
    totalContentLinesIn(currentFileDiff().lines)

  const diffLineToFileLineNum = (lineIdx: number) =>
    diffLineToFileLineNumIn(currentFileDiff().lines, lineIdx)

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
      const parts: ReturnType<typeof dim>[][] = []
      if (counts.M) parts.push([fg(th.commentMark)(String(counts.M)), dim("M")])
      if (counts.A) parts.push([fg(th.successFg)(String(counts.A)), dim("A")])
      if (counts.D) parts.push([fg("#f07178")(String(counts.D)), dim("D")])
      if (counts.R) parts.push([fg(th.treeActive)(String(counts.R)), dim("R")])
      const sep = t`  `.chunks
      treeHeaderText.content =
        parts.length > 0
          ? new StyledText([
              ...t`  ${dim("Files")}  `.chunks,
              ...parts.flatMap((p, i) => (i > 0 ? [...sep, ...p] : p)),
            ])
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
      fd.file.length > treeAvail
        ? "…" + fd.file.slice(-(treeAvail - 1))
        : fd.file
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
  const footerPosition = new TextRenderable(renderer, {
    content: "",
    width: 24,
  })
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
    } else if (
      info !== null &&
      isLineCommented(file, info.lineNum, info.side)
    ) {
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
  const exportToMarkdown = async (prompt: string) => {
    if (comments.size === 0) {
      footerText.content = `  ✗ No comments to export`
      footerText.fg = theme().commentMark
      setTimeout(() => updateFooter(), 2000)
      return
    }
    await Bun.write(
      EXPORT_PATH,
      buildReviewMarkdown(comments, fileDiffs, prompt),
    )
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
    } else if (
      e.name === "return" ||
      e.name === "enter" ||
      e.sequence === "\r"
    ) {
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
}
