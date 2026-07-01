#!/usr/bin/env bun
// Thin entry point: parse args → gather the diff → load persisted state → run
// the TUI. Everything else lives in the sibling modules (cli, git, model,
// export, ui/*).

import { parseArgs, HELP } from "./cli.ts"
import { gatherDiff } from "./git.ts"
import {
  loadComments,
  DEFAULT_EXPORT_PROMPT,
  type Annotation,
} from "./model.ts"
import { buildReviewMarkdown, buildReviewJson } from "./export.ts"
import { loadSettings } from "./ui/settings.ts"
import { runApp } from "./ui/app.ts"

const { help, againstBranch, rawTarget, exportMode, format, out } = parseArgs(
  process.argv.slice(2),
)

if (help) {
  console.log(HELP)
  process.exit(0)
}

const diff = await gatherDiff({ rawTarget, againstBranch }).catch(
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)

const AUTOSAVE_PATH = `${diff.targetDir}/.revu.json`
const EXPORT_PATH = `${diff.targetDir}/revu-review.md`

const comments = new Map<string, Annotation>()
const { prompt } = await loadComments(AUTOSAVE_PATH, comments)
const savedPrompt = prompt ?? DEFAULT_EXPORT_PROMPT

// Headless export — build the artifact from .revu.json and exit without a TUI.
if (exportMode) {
  if (comments.size === 0) {
    console.error(
      `No annotations to export — ${AUTOSAVE_PATH} is empty or missing.`,
    )
    process.exit(1)
  }
  const outPath =
    out ??
    (format === "json" ? `${diff.targetDir}/revu-review.json` : EXPORT_PATH)
  const content =
    format === "json"
      ? JSON.stringify(
          buildReviewJson(comments, diff.fileDiffs, savedPrompt),
          null,
          2,
        ) + "\n"
      : buildReviewMarkdown(comments, diff.fileDiffs, savedPrompt)
  await Bun.write(outPath, content)
  console.log(`Exported ${comments.size} annotation(s) to ${outPath}`)
  process.exit(0)
}

const { themeIndex, diffView } = loadSettings()

await runApp({
  fileDiffs: diff.fileDiffs,
  files: diff.files,
  prMode: diff.prMode,
  currentBranch: diff.currentBranch,
  againstBranch: diff.againstBranch,
  commitList: diff.commitList,
  comments,
  savedPrompt,
  themeIndex,
  diffView,
  autosavePath: AUTOSAVE_PATH,
  exportPath: EXPORT_PATH,
})
