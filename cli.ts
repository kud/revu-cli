// CLI argument parsing and help text. The entry point (index.ts) prints HELP
// and exits; everything else is orchestration.

export const HELP = `revu — interactive diff reviewer

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
  revu-review.md                Markdown export for AI review (press e to generate)`

export interface ParsedArgs {
  help: boolean
  againstBranch: string | null
  rawTarget: string
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const help = argv.includes("--help") || argv.includes("-h")
  let againstBranch: string | null = null
  const positionalArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--against" && argv[i + 1]) {
      againstBranch = argv[++i]!
    } else {
      positionalArgs.push(argv[i]!)
    }
  }
  const rawTarget = positionalArgs[0] ?? process.cwd()
  return { help, againstBranch, rawTarget }
}
