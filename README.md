# Panda Live

English | [简体中文](README.zh-CN.md)

Panda Live is a local-first desktop document editor. It keeps source and rendered output in sync, preserves each file's original encoding and line endings, and never uploads your drafts or documents.

## Highlights

- **Multiple view modes** — source (CodeMirror 6), WYSIWYG (ProseMirror, with a Word-style block toolbar and slash commands), split, rendered preview and a read-only Git diff view.
- **Rendered Git diff** — compare the current buffer or two commits. Markdown is compared in rendered form with block/word/ghost decorations; every other text format gets a side-by-side, syntax-highlighted source diff.
- **Git-compatible diff options** — `-w` (ignore whitespace), `--ignore-blank-lines`, and `--ignore-cr-at-eol` are available as independent toggles.
- **Git workflow** — the sidebar's Git tab has Changes / History / Compare views: stage, unstage, commit and amend, switch and create branches, pull / push, ahead/behind badges, and file-level comparison between any two commits (or a commit and the working tree). Pull strategy, network timeout, auto-refresh and the default diff baseline are configurable under **Settings → Git**.
- **Markdown pipeline** — GFM, front matter, math (KaTeX), syntax highlighting (Shiki), MyST directives (tab-set / grid), and sanitized HTML.
- **LaTeX preview** — compile with Tectonic, latexmk or xelatex; diagnostics are collected in the Problems panel.
- **Diagrams** — PlantUML and Mermaid preview with caching, theme support and a zoomable viewer: standalone files and diagrams embedded in Markdown zoom via the toolbar or Ctrl +/- and Ctrl+wheel, with a reset to natural width.
- **Image preview** — PNG, APNG, JPEG/JFIF, GIF, WebP, BMP, ICO and AVIF open read-only with the same zoomable viewer.
- **Bilingual UI** — Chinese and English, switchable at runtime.
- **Desktop integration** — workspace sidebar, outline, recovery drafts, recent files, and installable format extensions. The mode bar exposes format-aware export: Markdown opens an HTML / PDF menu, while PlantUML and Mermaid export SVG directly.

## Supported formats

| Kind | Formats |
|---|---|
| Documents | Markdown, plain text, PDF (read-only preview) |
| Markup / math | LaTeX (`.tex`), MathML, HTML, XML, SVG |
| Diagrams | PlantUML, Mermaid |
| Images | PNG, APNG, JPEG/JFIF, GIF, WebP, BMP, ICO, AVIF (read-only preview) |
| Code | C/C++, Java, JavaScript/TypeScript, JSON, YAML, CSS, Python, SQL, PHP, Rust, C#, Go, Ruby, Kotlin, Swift, R, Scala, Shell, Dart, Lua, Perl, Objective-C, INI, TOML |

Extensions can contribute additional formats, previews and commands.

## Language

The interface ships in Simplified Chinese and English. Choose a preference under **Settings → Appearance → Language**:

- **中文** — always Chinese
- **English** — always English
- **跟随系统 / System** — follow the operating system language

The preference is stored in `settings.json` in the application data directory.

## Getting started

Requirements for running from source and building:

- Node.js 22 or newer, npm 10 or newer
- Git is optional (needed for repository-based diffs; install it separately)
- Tectonic, latexmk or xelatex is optional (needed for LaTeX compilation)

```bash
npm install
npm run dev        # start the Electron app with Vite
```

Build a production bundle:

```bash
npm run build
npm run win        # run the built app
npm run package    # build an installer for the current platform
```

### Packaged build

On Windows, `npm run package` produces:

- `release/Panda Live Setup <version>.exe` — an NSIS installer that can be distributed as a single file; assisted install with a directory picker, desktop and Start-menu shortcuts created automatically;
- `release/win-unpacked/Panda Live.exe` — a no-install build; keep the whole `win-unpacked` folder (DLLs, locales, resources).

The packaged app bundles the Electron runtime, application code and the Tectonic executable for the current platform, so **the target machine does not need Node.js or npm**. Notes:

- **Git** is not bundled: install `git` system-wide, or point to an absolute path / `wsl git` under **Settings → Git**. Without Git, editing and export still work and diffs fall back to "last saved";
- **LaTeX** ships with Tectonic, but the first compile downloads the TeX bundle from the network (cached afterwards); a local latexmk / xelatex can be used instead;
- **Electron binary download**: `npm run package` auto-downloads the Electron binary when it is missing locally (GitHub by default). If the download fails, set the mirror first:
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npm run package
  ```
- Installers are only produced for the platform they are built on.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Electron with the Vite dev server |
| `npm run build` | Type-check and build renderer + main process |
| `npm run win` | Run the built app |
| `npm run package` | Build an installer for the current platform (auto-downloads the Electron binary if missing; bundles Tectonic) |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run lint` | Lint with ESLint |
| `npm run typecheck` | Type-check without emitting |
| `npm run verify` | Lint, unit tests and build |

## Project layout

```
electron/        Main process: windows, IPC, files, Git, LaTeX, extensions
src/app/         React UI: toolbar, panes, dialogs, panels
src/i18n/        UI translations (Chinese source strings + English JSON)
src/diff/        Line/word diff, preview model, source markers
src/editor/      ProseMirror WYSIWYG editor
src/source/      CodeMirror source editor and language support
src/formats/     Markdown/LaTeX/diagram parsing and serialization
src/render/      Rendering pipeline, diagram service, export helpers
src/services/    Document manager, settings, workspace, search, drafts
src/shared/      Shared types and IPC contracts
scripts/         Packaging and build helper scripts
test/            Unit and Playwright tests
doc/             Design notes
```

## License

Apache-2.0
