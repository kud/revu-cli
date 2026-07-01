# Changelog

All notable changes to this project are documented here.

---

## 1.1.1 — 2026-07-01

### Fixed

- `npm install -g @kud/revu-cli` failed with `EBADPLATFORM` on macOS (and any platform other than Linux) because the `@opentui/core` platform-native packages were declared as hard `dependencies` — npm treats a mismatched `os` on a required dependency as fatal. They are now `optionalDependencies`, so npm installs only the native matching your platform. ([50ec3c0](https://github.com/kud/revu-cli/commit/50ec3c0))

---

## 1.1.0 — 2026-07-01

revu grows from a single-file interactive diff reviewer into a modular tool with a full AI-agent round-trip: triage severity, headless export, agent import, and pushing review comments straight to a GitHub PR.

### Highlights

- Annotations now carry a severity (blocker/concern/nitpick) and a status lifecycle (open/accepted/dismissed/resolved), shown as colour-coded badges, severity-tinted diff lines, and tree-view dots, with `v`/`t` keybindings to cycle them while reviewing. ([88e2571](https://github.com/kud/revu-cli/commit/88e2571f3f272755bc394d5c5c44178a577297ca), [4657c36](https://github.com/kud/revu-cli/commit/4657c3628df58233644112de6ef0d4fdd1072437))
- `revu --export [--format md|json] [--out <path>|-]` builds the full review headlessly, without opening the TUI — JSON output captures per-annotation severity, status, and the exact captured code range, and `--out -` streams straight to stdout for scripting and CI. ([7c3686c](https://github.com/kud/revu-cli/commit/7c3686cd772da495b39620687bd0eb9488a6a756))
- `revu --import <file.json>` closes the AI-agent loop: load an agent-generated review straight into the TUI for human triage, merging without clobbering existing notes and tagging each as `source: agent`. ([d05dbea](https://github.com/kud/revu-cli/commit/d05dbea6e64b2a5c6091b7a9597434baa46aadab))
- `revu --against <branch> --push-pr` posts triaged annotations as inline GitHub PR review comments, with `--dry-run` to preview first — stays local-first, no network calls unless you opt in. ([d4c0fce](https://github.com/kud/revu-cli/commit/d4c0fcef8ecfb443dd90f498adcc14ec10656341))
- The diff view now watches the working tree and reloads automatically as files change (on by default, `--no-watch` to opt out), preserving your annotations across reloads and flagging any whose anchor line disappeared as stale. ([4c3d6cb](https://github.com/kud/revu-cli/commit/4c3d6cb9bbb8a113a352ad2b97efc47e2da70f8d))

### Documentation

- Docs moved to a multi-page site with a slimmed-down README, then polished to match the canonical kud-site layout — hero icon, screenshot placement, and heading emoji. ([c53b809](https://github.com/kud/revu-cli/commit/c53b80973f76a8e8bb426687bbd73341365668a0), [9e2f577](https://github.com/kud/revu-cli/commit/9e2f5770b70163ec4c532214b99b08c4bf1fe6aa), [d348a76](https://github.com/kud/revu-cli/commit/d348a76cd056b7c8d3456f94320d488e864d9f6b), [3081b47](https://github.com/kud/revu-cli/commit/3081b474ae0f9ce4965c85fa0408fff627f1722d), [d6c7044](https://github.com/kud/revu-cli/commit/d6c7044c0715c6680caa0128b374d663f01dc0bc))

<details>
<summary>Internal (4 commits)</summary>

- Split the 2005-line `index.ts` into focused modules (`cli.ts`, `git.ts`, `model.ts`, `export.ts`, `ui/*`) with no behaviour change ([552610a](https://github.com/kud/revu-cli/commit/552610aebd10302363897b6dee319ee574ab7863))
- Reordered binary resolution to check the local bin before package resolution, for more predictable CLI startup ([e1a9252](https://github.com/kud/revu-cli/commit/e1a9252626968ece1c8a958365c3f89286f0ff28))
- Bumped optional platform dependencies to 1.0.13 ([34230ce](https://github.com/kud/revu-cli/commit/34230cef0e975dc2ee4ca5e76881ba87049c57b4))
- Fixed the npm OIDC publish workflow pattern ([aa0bf45](https://github.com/kud/revu-cli/commit/aa0bf45ae758651fc7d4e09a6ec17ab041d77d24))

</details>
