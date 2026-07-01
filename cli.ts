// CLI argument parsing and help text. The entry point (index.ts) prints HELP
// and exits; everything else is orchestration.

export const HELP = `revu — interactive diff reviewer

Usage:
  revu [path]                   Review staged/unstaged changes in [path] (default: cwd)
  revu --against <branch>       Review all commits between <branch> and HEAD
  revu --import <file.json>     Seed annotations from an agent review, then triage
  revu --export                 Build the review from .revu.json without the TUI
  revu --against <branch> --push-pr
                                Post annotations as inline comments on the branch's PR

Options:
  -h, --help                    Show this help
  --no-watch                    Disable live diff reload (watch is on by default)
  --import <file.json>          Load annotations (tagged source: agent) for triage
  --export                      Headless export — no TUI (for CI / agents)
  --format <md|json>            Export format (default: md)
  --out <path>                  Export destination ('-' for stdout;
                                default: revu-review.md / .json)
  --push-pr                     Post annotations to the current branch's GitHub PR
                                (requires --against; no network without this flag)
  --dry-run                     With --push-pr, preview the payload without posting

Keys:
  ↑↓ / j k                     Move cursor
  shift+↑↓                      Select range
  ↵                             Annotate line / range
  d                             Delete annotation on current line
  v                             Cycle severity (blocker / concern / nitpick)
  t                             Cycle triage status (open / accepted / dismissed / resolved)
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
  exportMode: boolean
  format: "md" | "json"
  out: string | null
  importPath: string | null
  pushPr: boolean
  dryRun: boolean
  watch: boolean
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const help = argv.includes("--help") || argv.includes("-h")
  const pushPr = argv.includes("--push-pr")
  const dryRun = argv.includes("--dry-run")
  // Watch is on by default for the interactive reviewer; --no-watch opts out.
  const watch = !argv.includes("--no-watch")
  let againstBranch: string | null = null
  let exportMode = false
  let format: "md" | "json" = "md"
  let out: string | null = null
  let importPath: string | null = null
  const positionalArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--against" && argv[i + 1]) {
      againstBranch = argv[++i]!
    } else if (a === "--export") {
      exportMode = true
    } else if (a === "--format" && argv[i + 1]) {
      format = argv[++i] === "json" ? "json" : "md"
    } else if (a === "--out" && argv[i + 1]) {
      out = argv[++i]!
    } else if (a === "--import" && argv[i + 1]) {
      importPath = argv[++i]!
    } else if (
      a === "--push-pr" ||
      a === "--dry-run" ||
      a === "--watch" ||
      a === "--no-watch"
    ) {
      // Boolean flags handled above via argv.includes.
    } else {
      positionalArgs.push(a)
    }
  }
  const rawTarget = positionalArgs[0] ?? process.cwd()
  return {
    help,
    againstBranch,
    rawTarget,
    exportMode,
    format,
    out,
    importPath,
    pushPr,
    dryRun,
    watch,
  }
}
