// Push a local review to a GitHub pull request as inline review comments.
// Network access happens only here, and only when the caller opts in via
// --push-pr — the rest of revu stays local-first.

import { type Annotation, parseCommentKey } from "./model.ts"

const sideToGh = (side: "old" | "new"): "LEFT" | "RIGHT" =>
  side === "old" ? "LEFT" : "RIGHT"

// Formats an annotation as a PR comment body: severity as a conventional-comment
// prefix, status when non-default, and a small revu attribution.
const formatBody = (ann: Annotation): string => {
  const prefix = ann.severity ? `**${ann.severity}:** ` : ""
  const status =
    ann.status && ann.status !== "open" ? `\n\n_status: ${ann.status}_` : ""
  return `${prefix}${ann.text}${status}\n\n_— via revu_`
}

export interface ReviewComment {
  path: string
  line: number
  side: "LEFT" | "RIGHT"
  start_line?: number
  start_side?: "LEFT" | "RIGHT"
  body: string
}

// Maps each annotation to a GitHub review comment. Single-line annotations use
// `line`/`side`; ranges add `start_line`/`start_side`.
export const buildPrReviewPayload = (
  comments: Map<string, Annotation>,
): ReviewComment[] => {
  const out: ReviewComment[] = []
  for (const [key, ann] of comments) {
    const { file, side, startLine, endLine } = parseCommentKey(key)
    const ghSide = sideToGh(side)
    const comment: ReviewComment = {
      path: file,
      line: endLine,
      side: ghSide,
      body: formatBody(ann),
    }
    if (endLine !== startLine) {
      comment.start_line = startLine
      comment.start_side = ghSide
    }
    out.push(comment)
  }
  return out
}

export interface PrRef {
  number: number
  nameWithOwner: string
}

// Best-effort detection of the open PR for the current branch. Returns null if
// gh is unavailable, unauthenticated, or no PR exists.
export const detectPr = async (cwd: string): Promise<PrRef | null> => {
  try {
    const numberText = (
      await Bun.$`gh pr view --json number -q .number`.cwd(cwd).text()
    ).trim()
    const number = parseInt(numberText, 10)
    if (!Number.isFinite(number)) return null
    const nameWithOwner = (
      await Bun.$`gh repo view --json nameWithOwner -q .nameWithOwner`
        .cwd(cwd)
        .text()
    ).trim()
    if (!nameWithOwner) return null
    return { number, nameWithOwner }
  } catch {
    return null
  }
}

export interface PushOptions {
  cwd: string
  comments: Map<string, Annotation>
  dryRun: boolean
}

// Posts the review to the current branch's PR. With dryRun, prints the payload
// (and the resolved target, best-effort) without any mutation.
export const pushReviewToPr = async (opts: PushOptions): Promise<void> => {
  const { cwd, comments, dryRun } = opts
  const reviewComments = buildPrReviewPayload(comments)
  const pr = await detectPr(cwd)
  const body = {
    event: "COMMENT",
    body: `revu review — ${reviewComments.length} annotation(s)`,
    comments: reviewComments,
  }

  if (dryRun) {
    const target = pr
      ? `${pr.nameWithOwner}#${pr.number}`
      : "(no PR detected for the current branch)"
    console.log(
      `[dry-run] Would post ${reviewComments.length} comment(s) to ${target}:`,
    )
    console.log(JSON.stringify(body, null, 2))
    return
  }

  if (!pr) {
    throw new Error("No open pull request found for the current branch.")
  }

  const payloadPath = `${process.env.TMPDIR ?? "/tmp"}/revu-pr-review-${pr.number}.json`
  await Bun.write(payloadPath, JSON.stringify(body))
  try {
    await Bun.$`gh api repos/${pr.nameWithOwner}/pulls/${pr.number}/reviews -X POST --input ${payloadPath}`
      .cwd(cwd)
      .quiet()
  } finally {
    await Bun.$`rm -f ${payloadPath}`.nothrow().quiet()
  }
  console.log(
    `Posted ${reviewComments.length} comment(s) to ${pr.nameWithOwner}#${pr.number}.`,
  )
}
