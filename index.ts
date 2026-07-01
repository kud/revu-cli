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
import { loadSettings } from "./ui/settings.ts"
import { runApp } from "./ui/app.ts"

const { help, againstBranch, rawTarget } = parseArgs(process.argv.slice(2))

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

const { themeIndex, diffView } = loadSettings()

const AUTOSAVE_PATH = `${diff.targetDir}/.revu.json`
const EXPORT_PATH = `${diff.targetDir}/revu-review.md`

const comments = new Map<string, Annotation>()
const { prompt } = await loadComments(AUTOSAVE_PATH, comments)
const savedPrompt = prompt ?? DEFAULT_EXPORT_PROMPT

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
