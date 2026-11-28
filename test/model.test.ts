import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Annotation,
  DEFAULT_EXPORT_PROMPT,
  commentKey,
  cycleSeverity,
  cycleStatus,
  findCommentKeyForLine,
  importAnnotations,
  isLineCommented,
  loadComments,
  parseCommentKey,
  saveComments,
} from "../model.ts"

const dir = mkdtempSync(join(tmpdir(), "revu-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("commentKey / parseCommentKey", () => {
  test("single line defaults to new side", () => {
    expect(commentKey("a.ts", 5)).toBe("a.ts:new:5")
    expect(commentKey("a.ts", 5, 5)).toBe("a.ts:new:5")
  })

  test("range is normalised low-high", () => {
    expect(commentKey("a.ts", 9, 3, "old")).toBe("a.ts:old:3-9")
  })

  test("round-trips", () => {
    expect(parseCommentKey("src/x.ts:old:3-9")).toEqual({
      file: "src/x.ts",
      side: "old",
      startLine: 3,
      endLine: 9,
    })
    expect(parseCommentKey("b.md:new:7")).toEqual({
      file: "b.md",
      side: "new",
      startLine: 7,
      endLine: 7,
    })
  })
})

describe("cycling", () => {
  test("severity cycles none → blocker → concern → nitpick → none", () => {
    expect(cycleSeverity(undefined)).toBe("blocker")
    expect(cycleSeverity("blocker")).toBe("concern")
    expect(cycleSeverity("concern")).toBe("nitpick")
    expect(cycleSeverity("nitpick")).toBeUndefined()
  })

  test("status cycles and wraps", () => {
    expect(cycleStatus(undefined)).toBe("accepted")
    expect(cycleStatus("accepted")).toBe("dismissed")
    expect(cycleStatus("dismissed")).toBe("resolved")
    expect(cycleStatus("resolved")).toBe("open")
  })
})

describe("line lookup", () => {
  const comments = new Map<string, Annotation>([
    ["a.ts:new:4", { text: "single" }],
    ["a.ts:new:10-12", { text: "range" }],
    ["a.ts:old:4", { text: "old side" }],
  ])

  test("isLineCommented honours ranges and sides", () => {
    expect(isLineCommented(comments, "a.ts", 4)).toBe(true)
    expect(isLineCommented(comments, "a.ts", 11)).toBe(true)
    expect(isLineCommented(comments, "a.ts", 13)).toBe(false)
    expect(isLineCommented(comments, "a.ts", 11, "old")).toBe(false)
    expect(isLineCommented(comments, "b.ts", 4)).toBe(false)
  })

  test("findCommentKeyForLine returns the matching key", () => {
    expect(findCommentKeyForLine(comments, "a.ts", 12)).toBe("a.ts:new:10-12")
    expect(findCommentKeyForLine(comments, "a.ts", 4, "old")).toBe("a.ts:old:4")
    expect(findCommentKeyForLine(comments, "a.ts", 99)).toBeNull()
  })
})

describe("persistence", () => {
  test("save then load round-trips and omits default triage fields", async () => {
    const path = join(dir, "roundtrip.json")
    const comments = new Map<string, Annotation>([
      ["a.ts:new:1", { text: "plain", status: "open", source: "human" }],
      [
        "a.ts:old:2-3",
        { text: "triaged", severity: "blocker", status: "accepted", source: "agent" },
      ],
    ])
    await saveComments(path, comments, "my prompt")
    const raw = await Bun.file(path).json()
    expect(raw.prompt).toBe("my prompt")
    expect(raw.comments[0]).toEqual({
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      text: "plain",
      side: "new",
    })
    expect(raw.comments[1]).toMatchObject({
      severity: "blocker",
      status: "accepted",
      source: "agent",
    })

    const loaded = new Map<string, Annotation>()
    const { prompt } = await loadComments(path, loaded)
    expect(prompt).toBe("my prompt")
    expect([...loaded.keys()]).toEqual(["a.ts:new:1", "a.ts:old:2-3"])
    expect(loaded.get("a.ts:old:2-3")?.severity).toBe("blocker")
  })

  test("loadComments on a missing file returns null prompt", async () => {
    const m = new Map<string, Annotation>()
    expect(await loadComments(join(dir, "nope.json"), m)).toEqual({ prompt: null })
    expect(m.size).toBe(0)
  })

  test("importAnnotations tags agent source and never clobbers", async () => {
    const path = join(dir, "import.json")
    await Bun.write(
      path,
      JSON.stringify({
        prompt: "p",
        comments: [
          { file: "a.ts", startLine: 1, endLine: 1, text: "from agent" },
          { file: "a.ts", startLine: 5, endLine: 6, text: "new range" },
        ],
      }),
    )
    const m = new Map<string, Annotation>([["a.ts:new:1", { text: "human wins" }]])
    const res = await importAnnotations(path, m)
    expect(res).toEqual({ prompt: "p", added: 1 })
    expect(m.get("a.ts:new:1")?.text).toBe("human wins")
    expect(m.get("a.ts:new:5-6")).toMatchObject({ text: "new range", source: "agent" })
  })

  test("importAnnotations throws on a missing file", async () => {
    await expect(importAnnotations(join(dir, "missing.json"), new Map())).rejects.toThrow(
      "Import file not found",
    )
  })

  test("default prompt is non-empty", () => {
    expect(DEFAULT_EXPORT_PROMPT.length).toBeGreaterThan(0)
  })
})
