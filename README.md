<p align="center">
  <img src="assets/revu-logo.png" width="120" alt="revu logo" />
</p>

# revu

Interactive terminal diff reviewer. Annotate diffs, export reviews to Markdown.

<p align="center">
  <a href="https://asciinema.org/a/J4sEsjyCGSp6IXVc">
    <img src="assets/demo.gif" alt="revu demo" />
  </a>
</p>

## Install

```sh
npm install -g @kud/revu-cli
```

## Usage

```sh
# Review staged/unstaged changes in the current repo
revu

# Review a specific file
revu src/foo.ts

# Review all commits between a branch and HEAD (PR mode)
revu --against main
```

## Keys

| Key          | Action                              |
| ------------ | ----------------------------------- |
| `↑↓` / `j k` | Move cursor                         |
| `shift+↑↓`   | Select range                        |
| `↵`          | Annotate line / range               |
| `d`          | Delete annotation                   |
| `] [`        | Next / prev hunk                    |
| `c C`        | Next / prev annotation              |
| `n p`        | Next / prev file                    |
| `{ }`        | Scroll annotation preview           |
| `←`          | Back to file tree                   |
| `e`          | Export annotations to Markdown      |
| `s`          | Settings (theme, view, output file) |
| `q`          | Quit                                |

## Config

Press `s` inside revu to open settings. Changes are saved automatically:

- **Global** (theme, view mode) → `~/.config/revu/settings.json`
- **Per-repo** (output filename) → `revu.json` in the repo root
