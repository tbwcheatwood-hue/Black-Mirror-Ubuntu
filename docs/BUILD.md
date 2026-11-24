# BUILD

How to build, run and package Black Mirror.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 18 (tested on 24) | Build-time only. Packaged installers do not need Node. |
| npm | ≥ 9 | Ships with Node |
| Windows | 10/11 x64 | Target platform. Dev/test runs on Linux/macOS with reduced feature scope (no Windows hardware probes). |

## Development install (from source)

```powershell
cd black-mirror
npm install          # Electron + builder + renderer libs (~100 MB first run)
npm run postinstall  # vendors renderer bundles (marked, highlight.js) — runs automatically
npm test             # 116 automated tests, no Electron or Windows needed
npm start            # launch the app
```

`scripts/setup-windows.ps1` (or `scripts\setup.cmd`) performs the same steps with dependency checks and first-run hints.

## Runtime data layout

Everything Black Mirror writes lives in an isolated folder — no system settings, registry entries beyond the standard uninstaller, or foreign directories are touched:

```
%APPDATA%\BlackMirror\
├── config.json            global settings (template: config/config.template.json)
├── models.json            model library index (path references + metadata cache)
├── engines.json           installed engine versions, active tags, custom paths
├── benchmarks.json        benchmark results
├── remotes.json           connect-only remote endpoint registry
├── engines\<engineId>\<tag>\    extracted engine binaries (the only files uninstall may delete)
├── engines.d\*.json       user-contributed engine descriptors (loaded without app changes)
├── conversations\conv-*.json    chat history, one file per conversation
├── server-logs\*.log      per-process inference logs
└── logs\blackmirror-*.log rotating application diagnostics
```

## Packaging for Windows

```powershell
npm run build:win    # NSIS installer + portable .exe → dist\
npm run build:dir    # unpacked dist\win-unpacked\ (no installer step) — useful when NSIS is unavailable
```

- The NSIS installer allows choosing the install directory; the portable build is a single `.exe`.
- electron-builder downloads the matching Electron prebuilt binaries automatically.
- **Cross-building from Linux:** `npm run build:dir` works on Linux (downloads the Windows Electron distribution and packages the app). NSIS installer generation on Linux requires wine; on a Windows machine, `build:win` needs nothing extra. If NSIS cannot run in your environment, `build:dir` output is fully functional — zip `win-unpacked\` and run `Black Mirror.exe`.
- `scripts/package.cmd` is the one-click wrapper for Windows.

## What ships vs. what downloads

The repository/zip deliberately contains **no model weights and no engine binaries**. Engines are acquired at runtime through Inference Engines → Install, which pulls official release artifacts from the engine's own GitHub/website into the isolated engines folder:

| Engine | Source | Typical download |
|---|---|---|
| llama.cpp CPU/Vulkan/SYCL | `github.com/ggml-org/llama.cpp` releases (stable pointer tag → asset HEAD-verification with tag walk-back) | 12–90 MB zip per variant |
| Lemonade | `github.com/lemonade-sdk/lemonade` releases (embeddable zip) | ~1 MB zip (models download later) |
| Ollama | `https://ollama.com/download/OllamaSetup.exe` (official installer) | ~700 MB; models pulled separately via Ollama's own registry |

## Build verification checklist

1. `npm test` — 113/116 green (3 Electron-GUI tests skip honestly without a display).
2. `npm start` — window opens, no console errors.
3. Inference Engines shows all five cards with honest status.
4. Install an engine, launch a model, chat, restart the app — conversation persists.
5. Quit while a server runs — the log shows `shutdown: stopping managed servers` and the process is gone.

## Uninstallation

- **Installer build:** standard Windows "Apps & Features" → Black Mirror → Uninstall (removes program files only).
- **Portable build:** delete the `.exe`.
- **User data:** delete `%APPDATA%\BlackMirror\` to remove settings, installed engines, conversation history and logs. Deleting this folder also removes engine binaries — nothing was installed outside it.
- Your model files are never touched by installing or uninstalling Black Mirror.
