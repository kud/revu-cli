#!/usr/bin/env node
import { createRequire } from "module"
import { execFileSync } from "child_process"

const require = createRequire(import.meta.url)

const PACKAGES = {
  "darwin-arm64": "@kud/revu-cli-darwin-arm64",
  "darwin-x64": "@kud/revu-cli-darwin-x64",
  "linux-x64": "@kud/revu-cli-linux-x64",
  "linux-arm64": "@kud/revu-cli-linux-arm64",
}

const platform = `${process.platform}-${process.arch}`
const pkg = PACKAGES[platform]

if (!pkg) {
  console.error(`revu-cli: unsupported platform: ${platform}`)
  process.exit(1)
}

let binaryPath
try {
  binaryPath = require.resolve(`${pkg}/revu-bin`)
} catch {
  console.error(
    `revu-cli: could not find binary for ${platform}. Try reinstalling revu-cli.`,
  )
  process.exit(1)
}

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: "inherit" })
} catch (err) {
  process.exit(err.status ?? 1)
}
