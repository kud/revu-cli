import { describe, expect, test } from "bun:test"
import { HELP, parseArgs } from "../cli.ts"

describe("parseArgs", () => {
  test("defaults: no flags, cwd target, watch on", () => {
    const a = parseArgs([])
    expect(a.help).toBe(false)
    expect(a.againstBranch).toBeNull()
    expect(a.rawTarget).toBe(process.cwd())
    expect(a.exportMode).toBe(false)
    expect(a.format).toBe("md")
    expect(a.out).toBeNull()
    expect(a.importPath).toBeNull()
    expect(a.pushPr).toBe(false)
    expect(a.dryRun).toBe(false)
    expect(a.watch).toBe(true)
  })

  test("help via -h and --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--help"]).help).toBe(true)
  })

  test("valued flags and positional target", () => {
    const a = parseArgs([
      "/repo",
      "--against",
      "main",
      "--export",
      "--format",
      "json",
      "--out",
      "-",
      "--import",
      "review.json",
      "--push-pr",
      "--dry-run",
      "--no-watch",
    ])
    expect(a.rawTarget).toBe("/repo")
    expect(a.againstBranch).toBe("main")
    expect(a.exportMode).toBe(true)
    expect(a.format).toBe("json")
    expect(a.out).toBe("-")
    expect(a.importPath).toBe("review.json")
    expect(a.pushPr).toBe(true)
    expect(a.dryRun).toBe(true)
    expect(a.watch).toBe(false)
  })

  test("unknown format falls back to md", () => {
    expect(parseArgs(["--format", "xml"]).format).toBe("md")
  })

  test("boolean flags are not taken as the positional target", () => {
    expect(parseArgs(["--dry-run", "--watch", "dir"]).rawTarget).toBe("dir")
  })
})

describe("HELP", () => {
  test("documents usage and core flags", () => {
    expect(HELP).toContain("Usage:")
    for (const flag of ["--against", "--import", "--export", "--push-pr"]) {
      expect(HELP).toContain(flag)
    }
  })
})

describe("revu --help (subprocess)", () => {
  test("prints help and exits 0", async () => {
    const proc = Bun.spawn(["bun", "index.ts", "--help"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out.trim()).toBe(HELP)
  })
})
