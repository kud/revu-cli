// Diff fetching, --against PR mode, file status, and pure diff-line helpers.

export interface FileDiff {
  file: string
  raw: string
  lines: string[]
  status?: string
}

export const splitByFile = (raw: string): FileDiff[] => {
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

export const getFiletype = (filename: string): string | undefined => {
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

// ── Pure diff-line math (operate on a FileDiff's `lines`) ──────────────────────

export const isContentLine = (l: string) =>
  (l.startsWith("+") && !l.startsWith("+++")) ||
  (l.startsWith("-") && !l.startsWith("---")) ||
  l.startsWith(" ")

export const rawToContentIdx = (lines: string[], rawIdx: number): number => {
  let idx = 0
  for (let i = 0; i < rawIdx && i < lines.length; i++) {
    if (isContentLine(lines[i]!)) idx++
  }
  return idx
}

export const nextContentRawIdx = (
  lines: string[],
  rawIdx: number,
  dir: 1 | -1,
): number => {
  let idx = rawIdx + dir
  while (idx >= 0 && idx < lines.length) {
    if (isContentLine(lines[idx]!)) return idx
    idx += dir
  }
  return rawIdx
}

export const firstContentRawIdx = (lines: string[]): number => {
  for (let i = 0; i < lines.length; i++) {
    if (isContentLine(lines[i]!)) return i
  }
  return 0
}

export const totalContentLines = (lines: string[]): number =>
  lines.filter(isContentLine).length

export type DiffLineInfo = { lineNum: number; side: "old" | "new" }

export const diffLineToFileLineNum = (
  lines: string[],
  lineIdx: number,
): DiffLineInfo | null => {
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

// ── Diff gathering ─────────────────────────────────────────────────────────────

export interface DiffData {
  targetDir: string
  prMode: boolean
  currentBranch: string | null
  againstBranch: string | null
  commitList: string[]
  fileDiffs: FileDiff[]
  files: string[]
}

export const gatherDiff = async ({
  rawTarget,
  againstBranch,
}: {
  rawTarget: string
  againstBranch: string | null
}): Promise<DiffData> => {
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
      throw new Error(
        `Branch '${againstBranch}' not found or has no common ancestor with HEAD.`,
      )
    }
    const nameStatus =
      await Bun.$`git diff --name-status ${againstBranch}...HEAD`
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
      await Bun.$`git log ${againstBranch}..HEAD --oneline`
        .cwd(targetDir)
        .text()
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
    throw new Error(
      prMode
        ? `No diff found between '${againstBranch}' and HEAD.`
        : "No diff found (neither staged nor unstaged changes).",
    )
  }

  const fileDiffs = splitByFile(fullDiff)
  if (prMode) {
    for (const fd of fileDiffs) fd.status = fileStatusMap.get(fd.file) ?? "M"
  }
  const files = fileDiffs.map((f) => f.file)

  return {
    targetDir,
    prMode,
    currentBranch,
    againstBranch,
    commitList,
    fileDiffs,
    files,
  }
}
