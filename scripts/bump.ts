#!/usr/bin/env bun
const type = process.argv[2] ?? "patch"
if (!["patch", "minor", "major"].includes(type)) {
  console.error(`Usage: bun scripts/bump.ts [patch|minor|major]`)
  process.exit(1)
}

const root = import.meta.dir + "/.."
const rootPkg = await Bun.file(`${root}/package.json`).json()

const [major, minor, patch] = rootPkg.version.split(".").map(Number)
const next =
  type === "major"
    ? `${major + 1}.0.0`
    : type === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`

const platforms = ["darwin-arm64", "linux-x64", "linux-arm64"]

rootPkg.version = next
for (const p of platforms)
  rootPkg.optionalDependencies[`@kud/revu-cli-${p}`] = next
await Bun.write(`${root}/package.json`, JSON.stringify(rootPkg, null, 2) + "\n")

for (const p of platforms) {
  const path = `${root}/npm-packages/${p}/package.json`
  const pkg = await Bun.file(path).json()
  pkg.version = next
  await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n")
}

const files = [
  "package.json",
  ...platforms.map((p) => `npm-packages/${p}/package.json`),
].join(" ")

await Bun.$`git -C ${root} add ${files.split(" ")}`
const msg = `🔖 chore(release): bump to ${next}`
await Bun.$`git -C ${root} commit -m ${msg}`
await Bun.$`git -C ${root} tag v${next}`
await Bun.$`git -C ${root} push origin main --tags`

console.log(`✓ released v${next}`)
