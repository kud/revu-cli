#!/usr/bin/env node
import { createRequire } from "module"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { existsSync } from "fs"

const require = createRequire(import.meta.url)

const PACKAGES = {
  "darwin-arm64": "@kud/revu-cli-darwin-arm64",
  "linux-x64": "@kud/revu-cli-linux-x64",
  "linux-arm64": "@kud/revu-cli-linux-arm64",
}

// Intel Macs run the arm64 binary via Rosetta
const platform =
  process.platform === "darwin" && process.arch === "x64"
    ? "darwin-arm64"
    : `${process.platform}-${process.arch}`

const pkg = PACKAGES[platform]

if (!pkg) {
  console.error(
    `revu-cli: unsupported platform: ${process.platform}-${process.arch}`,
  )
  process.exit(1)
}

const localBin = join(dirname(fileURLToPath(import.meta.url)), "../revu-bin")

let binaryPath
if (existsSync(localBin)) {
  binaryPath = localBin
} else {
  try {
    binaryPath = require.resolve(`${pkg}/revu-bin`)
  } catch {
    console.error(
      `revu-cli: could not find binary for ${platform}. Try reinstalling revu-cli.`,
    )
    process.exit(1)
  }
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true,
})
process.exit(result.status ?? 1)
