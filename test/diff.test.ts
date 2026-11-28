import { describe, expect, test } from "bun:test"
import {
  diffLineToFileLineNum,
  firstContentRawIdx,
  getFiletype,
  isContentLine,
  nextContentRawIdx,
  rawToContentIdx,
  splitByFile,
  totalContentLines,
} from "../git.ts"
import { buildReviewJson, buildReviewMarkdown, getRangeContent } from "../export.ts"
import { buildPrReviewPayload } from "../github.ts"
import { type Annotation } from "../model.ts"

const RAW = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -10,2 +10,3 @@
 # Title
+New line
 End
`

const files = splitByFile(RAW)
const a = files[0]!

describe("splitByFile", () => {
  test("splits per file and strips trailing blank lines", () => {
    expect(files.map((f) => f.file)).toEqual(["src/a.ts", "README.md"])
    expect(a.lines.at(-1)).toBe(" const c = 4")
  })
})

describe("getFiletype", () => {
  test("maps known extensions", () => {
    expect(getFiletype("x.tsx")).toBe("typescript")
    expect(getFiletype("X.PY")).toBe("python")
    expect(getFiletype("a.snap")).toBe("typescript")
    expect(getFiletype("Makefile")).toBeUndefined()
  })
})

describe("diff-line math", () => {
  test("isContentLine excludes headers", () => {
    expect(isContentLine("+++ b/x")).toBe(false)
    expect(isContentLine("--- a/x")).toBe(false)
    expect(isContentLine("+x")).toBe(true)
    expect(isContentLine("-x")).toBe(true)
    expect(isContentLine(" x")).toBe(true)
    expect(isContentLine("@@ -1 +1 @@")).toBe(false)
  })

  test("content indexing", () => {
    const first = firstContentRawIdx(a.lines)
    expect(a.lines[first]).toBe(" const a = 1")
    expect(totalContentLines(a.lines)).toBe(4)
    expect(rawToContentIdx(a.lines, first + 2)).toBe(2)
    expect(nextContentRawIdx(a.lines, first, 1)).toBe(first + 1)
    expect(nextContentRawIdx(a.lines, first, -1)).toBe(first)
  })

  test("diffLineToFileLineNum maps each side", () => {
    const first = firstContentRawIdx(a.lines)
    expect(diffLineToFileLineNum(a.lines, first)).toEqual({ lineNum: 1, side: "new" })
    expect(diffLineToFileLineNum(a.lines, first + 1)).toEqual({ lineNum: 2, side: "old" })
    expect(diffLineToFileLineNum(a.lines, first + 2)).toEqual({ lineNum: 2, side: "new" })
    expect(diffLineToFileLineNum(a.lines, first + 3)).toEqual({ lineNum: 3, side: "new" })
  })
})

describe("export", () => {
  test("getRangeContent reads new and old sides", () => {
    expect(getRangeContent(a, 2, 3)).toBe("const b = 3\nconst c = 4")
    expect(getRangeContent(a, 2, 2, "old")).toBe("const b = 2")
  })

  const comments = new Map<string, Annotation>([
    ["src/a.ts:new:2", { text: "why 3?", severity: "concern" }],
    ["src/a.ts:old:2", { text: "was fine", status: "dismissed" }],
  ])

  test("buildReviewMarkdown includes prompt, code and severity", () => {
    const md = buildReviewMarkdown(comments, files, "Fix it")
    expect(md.startsWith("Fix it\n\n---\n\n# Code Review")).toBe(true)
    expect(md).toContain("## `src/a.ts`")
    expect(md).toContain("```ts\nconst b = 3\n```")
    expect(md).toContain("> **concern:** why 3?")
    expect(md).toContain("Line 2 (removed) — _dismissed_")
  })

  test("buildReviewJson resolves defaults", () => {
    const json = buildReviewJson(comments, files, "p")
    expect(json.prompt).toBe("p")
    expect(json.comments).toHaveLength(2)
    const added = json.comments.find((c) => c.side === "new")!
    expect(added).toMatchObject({
      severity: "concern",
      status: "open",
      source: "human",
      code: "const b = 3",
    })
  })
})

describe("buildPrReviewPayload", () => {
  test("maps sides and ranges to GitHub review comments", () => {
    const payload = buildPrReviewPayload(
      new Map<string, Annotation>([
        ["a.ts:new:4", { text: "hi", severity: "nitpick" }],
        ["a.ts:old:2-5", { text: "range", status: "accepted" }],
      ]),
    )
    expect(payload[0]).toEqual({
      path: "a.ts",
      line: 4,
      side: "RIGHT",
      body: "**nitpick:** hi\n\n_— via revu_",
    })
    expect(payload[1]).toMatchObject({
      line: 5,
      side: "LEFT",
      start_line: 2,
      start_side: "LEFT",
    })
    expect(payload[1]!.body).toContain("_status: accepted_")
  })
})
