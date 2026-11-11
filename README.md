# Panda Live

English | [简体中文](README.zh-CN.md)

Panda Live is a local-first desktop document editor. It keeps source and rendered output in sync, preserves each file's original encoding and line endings, and never uploads your drafts or documents.

## Highlights

- **Multiple view modes** — source (CodeMirror 6), WYSIWYG (ProseMirror), split, rendered preview and a read-only Git diff view.
- **Rendered Git diff** — compare the current buffer or two commits. Markdown is compared in rendered form with block/word/ghost decorations; every other text format gets a side-by-side, syntax-highlighted source diff.
- **Git-compatible diff options** — `-w` (ignore whitespace), `--ignore-blank-lines`, and `--ignore-cr-at-eol` are available as independent toggles.
- **Markdown pipeline** — GFM, front matter, math (KaTeX), syntax highlighting (Shiki), and sanitized HTML.
- **LaTeX preview** — compile with Tectonic, latexmk or xelatex; diagnostics are collected in the Problems panel.
- **Diagrams** — PlantUML and Mermaid preview with caching and theme support.
- **Bilingual UI** — Chinese and English, switchable at runtime.
- **Desktop integration** — workspace sidebar, outline, recovery drafts, recent files, HTML/PDF/SVG export, and installable format extensions.

## Supported formats

| Kind | Formats |
|---|---|
| Documents | Markdown, plain text |
| Markup / math | LaTeX (`.tex`), MathML, HTML, XML |
| Diagrams | PlantUML, Mermaid |
| Code | C/C++, Java, JavaScript/TypeScript, JSON, YAML, CSS, Python, SQL, PHP, Rust, C#, Go, Ruby, Kotlin, Swift, R, Scala, Shell, Dart, Lua, Perl, Objective-C, INI, TOML |

Extensions can contribute additional formats, previews and commands.

## Language

The interface ships in Simplified Chinese and English. Switch instantly with the globe button in the toolbar, or choose a preference under **Settings → Appearance → Language**:

- **中文** — always Chinese
- **English** — always English
- **跟随系统 / System** — follow the operating system language

The preference is stored in `settings.json` in the application data directory.

## Getting started

Requirements:

- Node.js 22 or newer, npm 10 or newer
- Git is optional (needed for repository-based diffs)
- Tectonic, latexmk or xelatex is optional (needed for LaTeX compilation)

```bash
npm install
npm run dev        # start the Electron app with Vite
```

Build a production bundle:

```bash
npm run build
npm run win        # run the built app
npm run package    # build an installer
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Electron with the Vite dev server |
| `npm run build` | Type-check and build renderer + main process |
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
test/            Unit and Playwright tests
doc/             Design notes
```

## License

Apache-2.0
