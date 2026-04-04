#!/usr/bin/env bun
// One-pass cast post-processor:
//   1. Cap idle gaps (delta > MAX_IDLE → MAX_IDLE)
//   2. Trim trailing Bun crash/error frames
//   3. Scale total to TARGET_DURATION
//   4. Set title in header

const MAX_IDLE = 0.33
const TARGET_DURATION = 18.0
const TITLE = "revu-cli"
const ERROR_MARKERS = ["$bunfs", "Bun v", "TextBuffer is destroyed"]

const path = process.argv[2]
if (!path) {
  console.error("Usage: bun scripts/process-cast.js <cast-file>")
  process.exit(1)
}

const lines = (await Bun.file(path).text()).split("\n").filter((l) => l.trim())
const header = JSON.parse(lines[0])
const events = lines.slice(1).map((l) => JSON.parse(l))

const capped = events.map((e) => [Math.min(e[0], MAX_IDLE), ...e.slice(1)])

const cutoff = capped.findIndex((e) =>
  ERROR_MARKERS.some((m) => (e[2] ?? "").includes(m)),
)
const trimmed = cutoff === -1 ? capped : capped.slice(0, cutoff)

const total = trimmed.reduce((s, e) => s + e[0], 0)
const scale = TARGET_DURATION / total
const scaled = trimmed.map((e) => [
  Math.round(e[0] * scale * 1e6) / 1e6,
  ...e.slice(1),
])

header.title = TITLE

const out =
  [JSON.stringify(header), ...scaled.map((e) => JSON.stringify(e))].join("\n") +
  "\n"
await Bun.write(path, out)

console.log(
  `✓ processed: ${events.length} → ${trimmed.length} events, ${Math.round(total * 10) / 10}s → ${TARGET_DURATION}s`,
)
