<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)
![npm](https://img.shields.io/npm/v/@kud/revu-cli?style=flat-square&color=CB3837)
![MIT](https://img.shields.io/badge/licence-MIT-22C55E?style=flat-square)

**Interactive terminal diff reviewer**

<a href="https://kud.io/projects/revu-cli">Website</a> · <a href="https://kud.io/projects/revu-cli/docs">Documentation</a>

</div>

## Features

- **Line and range annotations** — comment on a single line or select a range and annotate the whole block.
- **Hunk and file navigation** — jump between hunks, annotations, and files without leaving the keyboard.
- **PR mode** — review every commit between a branch and `HEAD` with `--against`.
- **Markdown export** — export annotations to `revu-review.md`, with an optional AI context header, by pressing `e`.
- **Persistent reviews** — annotations autosave to `.revu.json` and survive across sessions.
- **Themeable** — switch theme and view mode from an in-app settings panel, saved to your user config.

<div align="center">

<a href="https://asciinema.org/a/SitNPy6fQpidFCcH">
  <img src="assets/demo.gif" alt="revu demo" />
</a>

</div>

## Install

```sh
npm install -g @kud/revu-cli
```

## Usage

```console
$ revu                  # review staged/unstaged changes in the current repo
$ revu src/foo.ts       # review a specific file
$ revu --against main   # review all commits between a branch and HEAD (PR mode)
```

Inside the reviewer, move with `↑↓` / `j k`, press `↵` to annotate a line, hold `shift` to select a range, and `e` to export to `revu-review.md`.

## Development

```sh
git clone https://github.com/kud/revu-cli.git
cd revu-cli
mise install
mise run dev    # run in hot-reload mode
mise run build  # compile a standalone binary
```

📚 **Full documentation → [revu-cli/docs](https://kud.io/projects/revu-cli/docs)**
