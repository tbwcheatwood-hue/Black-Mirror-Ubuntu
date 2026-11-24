# ARCHITECTURE

This document explains how Black Mirror is built, why each decision was made, and where every feature lives. It is written for maintainers and contributors.

## 1. Design goals

1. **The mirror remains.** Inference engines and model architectures change constantly; Black Mirror must not. Every engine-specific detail is isolated behind an adapter so a new engine is one JSON descriptor + one adapter class — no changes to chat, library, or server code.
2. **Target hardware first.** The reference machine is a Windows 11 PC with an i5-12500 (6P+6E cores, 12 threads), 44 GB RAM and Intel UHD 770 graphics — no discrete GPU. The default path is pure-CPU llama.cpp; acceleration options are offered *only* when the system can actually support them, and unsupported acceleration is never presented as functional.
3. **Testable core.** All business logic lives in plain Node modules with zero Electron imports. The Electron shell is a thin wiring layer. This lets the entire backend run (and be tested) in CI without a display, Windows, or a real engine.
4. **Never touch what it does not own.** Model files are only ever *read*. Engines are installed into Black Mirror's own data folder. Only process PIDs recorded in Black Mirror's registry can ever be stopped.

## 2. Technology stack and why

| Choice | Rationale |
|---|---|
| **Electron 33** (main: Node, renderer: DOM) | Native-feeling Windows desktop app, mature packaging to NSIS/portable via electron-builder, and — decisive for this project — the *same* JavaScript runtime on both sides lets the core modules be plain, testable Node. Tauri/Rust and .NET/WPF were rejected: cross-building them from a Linux CI to a verified Windows binary is far less reliable, and .NET cannot be developed at all in this environment. |
| **Vanilla JS renderer** (no framework, no build step) | The UI is seven views of forms, lists and a chat stream — a framework would add weight and churn without payoff. CSP forbids inline scripts; all code is plain `<script src>` modules that work identically in Electron and in a plain browser (the preview bridge). |
| **marked + highlight.js** | Battle-tested markdown and syntax highlighting; bundled into `renderer/vendor` at install time by `scripts/vendor-renderer-deps.js` (esbuild produces the IIFE bundle for highlight.js, which no longer ships UMD builds). |
| **No HTTP proxy for model traffic** | The renderer talks to the local inference server directly over `http://127.0.0.1:<port>/v1/...`. The main process handles lifecycle only. One fewer hop, no duplicated SSE logic, and the app cannot become a bandwidth bottleneck. |
| **JSON stores** (config.json, models.json, engines.json, benchmarks.json, conversations/*.json) | Human-readable, diffable, trivially testable, zero dependencies. Atomic writes via temp-file + rename. SQLite was considered and rejected as unnecessary for these sizes. |

## 3. Process architecture

```
┌───────────────────────────── Electron ─────────────────────────────┐
│  Renderer (DOM, sandboxed)            Main (Node)                  │
│  ├─ views/*.js  (7 views)             ├─ main.js (wiring)          │
│  ├─ streamclient.js ──────────────►   │    ├─ core/                │
│  │    direct OpenAI-compatible HTTP   │    │   config, store, log, │
│  │    to 127.0.0.1:<port>             │    │   events, util        │
│  ├─ bridge.js (IPC ⇄ mock)            │    ├─ models/              │
│  └─ markdown.js (marked + hljs)       │    │   gguf, library,      │
│                                       │    │   estimate            │
│        ▲ IPC (contextBridge)          │    ├─ engines/             │
│        └──── preload.cjs ────────►    │    │   registry, adapters, │
│                                       │    │   installer           │
│                                       │    ├─ server/              │
│                                       │    │   controller, ports,  │
│                                       │    │   logparse            │
│                                       │    ├─ monitor/             │
│                                       │    │   monitor, winprobe   │
│                                       │    └─ benchmark/bench.js   │
│                                       │    spawn ▼                 │
│                                       │  llama-server / ollama /   │
│                                       │  lemonade-server           │
└─────────────────────────────────────────────────────────────────────┘
```

Data flows:
- **Chat streaming**: renderer → `POST /v1/chat/completions (stream)` → engine. `streamclient.js` parses SSE, separates reasoning channels, collects usage. The main process is not in this path.
- **Lifecycle**: renderer → IPC (`servers:start`) → `ServerController` spawns the engine binary, streams stdout/stderr into a per-process log file + ring buffer, polls the readiness endpoint, emits events to the renderer.
- **Monitoring**: `Monitor` samples on a timer; Windows specifics (commit charge, per-process working sets) come from a persistent PowerShell probe (one spawn, JSON lines) via `winprobe.js`. Samples are pushed to the renderer.

## 4. Module reference

| Module | Responsibility |
|---|---|
| `main/core/store.js` | Atomic JSON persistence with corruption fallback |
| `main/core/config.js` | Global settings; defaults from `PARAM_SCHEMA`; `effectiveParams()` merges per-model profiles |
| `main/core/conversations.js` | One file per conversation; append/update/truncate; full-text search; auto-titling |
| `main/core/log.js` | Rotating diagnostic logs + ring buffer for diagnostics UI |
| `main/models/gguf.js` | GGUF v2/v3 header + KV parser (all 13 value types, arrays, tensor-section skip) |
| `main/models/library.js` | Directory scanning (bounded depth), import-without-copy, metadata cache keyed by mtime+size, favorites/categories/profiles, **split-GGUF grouping** (group size sums, missing-shard detection) and **mmproj projector indexing/pairing** |
| `main/models/estimate.js` | Quantization bpw table, KV-cache math, total memory estimate, pre-load assessment (warns, never blocks) |
| `main/engines/builtin/*.json` | Declarative engine descriptors (id, family, install asset templates, version probe regex, readiness probe, ports, capabilities, hardware notes) |
| `main/engines/adapters.js` | Per-family imperative glue: CLI argument mapping, request overrides, model listing, version parsing. `PARAM_SCHEMA` (single source of truth for UI + validation) |
| `main/engines/registry.js` | Descriptor loading (builtin + user `engines.d/*.json`), installed-version bookkeeping (multiple versions, active pointer, rollback), status snapshots with the **status taxonomy** (available / compatible / experimental / not-installed / error + reason), hardware detection |
| `main/engines/installer.js` | Tag resolution chain (explicit → stable pointer → GitHub API → releases-page scrape), **HEAD-verified asset with walk-back through recent tags**, download with progress, extraction (zip via `Expand-Archive`/`unzip`, `.tar.gz` via tar), version registration, safe uninstall |
| `main/server/ownership.js` | **v1.2.0** — process identity snapshots (exe/cmdline/start-time) and three-factor ownership verification; the base for crash recovery and PID-reuse protection |
| `main/server/controller.js` | The **only** module that spawns or kills inference processes. Duplicate-launch prevention, port conflict detection, readiness polling, log capture, `taskkill /T /F` on Windows / SIGTERM→SIGKILL escalation elsewhere. **v1.1.0:** persisted connect-only remote endpoint registry. **v1.2.0:** VERIFIED termination (exit + port release + endpoint silence, honest unresolved reporting), persisted ownership records (`managed-processes.json`), `recoverAtStartup()` classification (adopted / external / cleared), `stopAll()` outcome summary |
| `main/server/ports.js` | Bind-test port availability (EADDRINUSE-safe), free-port finder |
| `main/server/logparse.js` | Extracts prompt/eval tokens-per-second and load times from llama.cpp log lines |
| `main/monitor/monitor.js` | CPU/RAM deltas, GPU telemetry (nvidia-smi when present; honest nulls otherwise), managed-process RSS, sampling loop |
| `main/monitor/winprobe.js` | Persistent PowerShell sampling loop (commit charge, top processes, per-PID working sets) |
| `main/benchmark/bench.js` | Repetition runner: fresh start → load time → prompt throughput → generation throughput (incremental SSE with **TTFT** capture) → peak RSS; persisted with environment metadata and a **comparability key** (engine version, acceleration, threads, context, KV) |
| `main/compatlab/assessor.js` | **v1.2.0** — pure compatibility assessment: model×engine×hardware×profile → verified/likely/experimental/insufficient/unsupported/previously-failed with reasons and checks |
| `main/compatlab/lab.js` | **v1.2.0** — manually initiated staged tests (startup → devices → load → inference → streaming → thinking → verified terminate), persisted results with staleness invalidation |
| `main/profiles.js` | **v1.2.0** — recommended launch profiles generated from detected hardware, model metadata and probed capabilities; advisory-only |
| `main/diagnostics.js` | **v1.2.0** — local snapshot collection + troubleshooting hints + local export (never transmitted) |
| `main/main.js` | Electron wiring: single-instance lock, window, IPC surface, clean shutdown (`stopAll` → close → exit) |
| `main/preload.cjs` | contextBridge API (namespaced, promise-based); pushes only whitelisted channels |
| `renderer/js/*` | UI: views, streamclient, markdown, bridge (real ⇄ preview mock), util |

## 5. Engine extensibility

Adding an engine = **drop a descriptor + register an adapter class**.

1. `main/engines/builtin/<id>.json` (or `%APPDATA%/BlackMirror/engines.d/<id>.json` for user-added engines, no app changes needed): declares family, install asset template, version probe, readiness probe, default port, capabilities.
2. If it needs new glue (e.g. a different CLI or a registry-backed model list), add a class in `adapters.js` implementing `executablePath()`, `buildServerArgs()`, `buildRequestOverrides()`, `parseVersionOutput()`, and optionally `listModels()` — then map `family → class` in `FAMILY_CLASSES`.

Everything else (UI cards, install/update/rollback, server lifecycle, chat, benchmarks) is generic and picks the new engine up automatically. This is the concrete guarantee behind "must not become obsolete".

## 6. Safety model

| Hazard | Guard |
|---|---|
| Duplicate managed launches | `ServerController` registry keyed by engine+model; `DuplicateProcessError` before spawn; single-instance app lock |
| Port conflicts | Bind-test *before* spawn with distinct error for "Black Mirror server" vs "another application" |
| Killing foreign processes | `stop()` refuses IDs not in the registry; external process list is read-only and labeled "never touched" |
| Silent context reduction | Adapters pass `--ctx-size`/`num_ctx` verbatim from user settings; covered by an explicit test |
| Truncated/corrupt GGUF | Parser classifies `bad-magic` / `truncated` / `version`; library lists the file with a readable error; app stays usable |
| Corrupt config | Store keeps a `.corrupt.<ts>` backup and falls back to defaults |
| Benchmark honesty | Numbers only from wall-clock timing of real requests and server-reported timings/usage; mock-based tests are labeled as pipeline verification |
| Unsafe uninstall | `uninstall()` refuses directories outside `engines/` |
| Engine hangs on quit | `before-quit` → `stopAll('app-shutdown')` → `app.exit(0)` |

## 7. Renderer preview mode

`renderer/js/bridge.js` binds to `window.blackMirror` (preload) when present; otherwise it instantiates `MockBridge`, which simulates engines/models/chat in the browser (with a clearly labeled banner). This is what makes pixel-accurate UI previews possible without launching Electron on a display, and it keeps the renderer's contract with the main process explicit: the mock implements the same surface, so any drift shows up immediately in preview.
