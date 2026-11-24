# Changelog

All notable changes to Black Mirror are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is semver.

## [1.2.2] — 2026-11-24

Focused corrective release for thinking control, server/conversation model identity, and chat telemetry. Preserves v1.2.1 architecture, installed engines and user data.

### Fixed
- **Thinking mode Off did not disable reasoning**: chat never received `server.params` because `ServerController._public()` omitted `params`, so the client always treated thinking as `auto`. Off now applies server flags (`--reasoning off`, `--reasoning-budget 0` when supported) and request body controls (`chat_template_kwargs.enable_thinking=false`, `think:false`, `reasoning_budget:0`). On/Auto map correctly. If a model still emits reasoning while Off, the UI shows an honest compatibility warning instead of silently hiding it.
- **Chat server badge showed `undefined :port`**: `_public()` omitted `displayName`; badge and model select now use a safe label with basename fallback and never render JavaScript `undefined`.
- **Conversation sidebar showed `no model`**: new chats and assistant messages now persist the active model/engine; append backfills conversation metadata; list resolves model from recent messages when the top-level field is missing, without inventing identities.
- **Token stats showed `null` / fabricated zeros**: streaming usage is normalized without inventing counts; cancelled generations no longer estimate tokens from character length; unavailable values display as `n/a`; session totals only sum measured completion tokens.

### Changed
- Capability probe recognizes `--reasoning` / `--reasoning-budget` / `--chat-template-kwargs` on llama.cpp b12359+.
- Regression suite adds dedicated v1.2.2 coverage for thinking payloads, identity, conversation persistence and usage telemetry.
- Version indicators and portable package aligned to **v1.2.2**.

## [1.2.1] — 2026-11-24

Windows hardware verification patch. Preserves the v1.2.0 baseline; ships one confirmed reliability fix discovered during source review and Windows install preparation.

### Fixed
- **GUI failed to open on Windows**: `initCore()` passed the `dataDir` *function* into `CompatibilityLab` instead of the resolved path string (`dd`). `JsonStore` then tried to `mkdir` a path containing the function source text and the main process aborted before `createWindow()`. Now passes `dataDir: dd`.
- **Renderer startup aborted on `server-log`**: Servers view subscribed to a `server-log` push channel that was omitted from the preload allowlist, throwing `channel not allowed: server-log` during `ServersView.init()` and stopping the whole bootstrap. Channel allowed; main process now also forwards `server-log` events on that channel.
- **`restart()` ignored `stop()` confirmation**: restart previously called `stop()` then immediately spawned a replacement process without inspecting the termination verdict. An unresolved stop could therefore leave two inference processes on the same port/model. Restart now requires `stopResult.confirmed === true` before `start()`, throws `stop-unresolved` with an accurate status summary when termination is unresolved, refuses remote-mode records (`not-owned`), and never weakens ownership safeguards. Regression tests cover happy-path restart, unresolved-stop refusal (no duplicate PID), and remote-mode refusal.
- **Windows process ownership snapshots always returned null**: `snapshotProcess()` short-circuited on `win32`, so spawn recording never stored a start-time and `recoverAtStartup()` could not adopt or correctly classify live processes. It now uses a synchronous Win32_Process PowerShell probe (with quoted command-line splitting) on real Windows hardware.
- **Installer/unit-test Windows portability**: fake-zip helper uses `Compress-Archive` on Windows (no Unix `zip` CLI); staged-binary validation tests create `llama-server.exe` on Windows to match the installer's host-platform check.

### Changed
- Automated tests 116 → **118** (+2 restart reliability regressions); Windows host now executes the full suite without POSIX-only helpers.
- Version indicators, portable package and documentation aligned to **v1.2.1**.

## [1.2.0] — 2026-11-24

Production-readiness release: manifest reproducibility, verified process termination, crash recovery with process-ownership verification, staged engine installs, Compatibility Lab, recommended profiles, diagnostics center. See PRODUCTION_READINESS.md and REFINEMENT_REPORT.md.

### Fixed (independently audited defects)
- **Distributed source manifest was incomplete**: no `scripts`, no `devDependencies`, no committed electron-builder config — documented commands could not run from the shipped source. Now complete, lockfile-synced and tested (`npm test` includes build reproducibility checks).
- **stop() reported unverified success**: termination is now confirmed (exit observed + port released + endpoint silent); unresolved stops are reported honestly. Regression-tested incl. sabotage-kill.
- **`main/engines/` was missing from version control** (unanchored `.gitignore` rule `engines/`); restored from the release archive, rule anchored, tree now fully committed.

### Added
- **Compatibility Lab** (model/engine inspection with confirmed-vs-estimated labels, 6-state honest assessment, manual staged tests with verified termination, persisted results with staleness invalidation) — see COMPATIBILITY_LAB.md.
- **Process ownership & recovery**: persisted identity records (exe + model + start time), startup re-verification, PID-reuse protection; unverifiable processes are classified external and never terminated.
- **Staged engine installs**: disk-space guard, optional official checksum verification, extraction validation before activation — failed updates never damage the previous working version.
- **Recommended launch profiles** (7 goals) generated from detected hardware, model metadata and probed capabilities; advisory-only, explicit apply.
- **Diagnostics Center**: local snapshot + plain-language troubleshooting hints + local export. Nothing transmitted.
- **Benchmark comparability metadata** (engine version/acceleration/threads/context/KV key) and JSON export.
- **Expanded real-inference verification**: 2 architectures × 2 quantizations, multiple contexts, streaming TTFT, mid-stream cancellation, restart, model switching, 3 verified load/unload cycles — 12/12 checks (Linux CPU).
- Electron runtime tests (binary smoke + module-graph load; GUI launch skips honestly without a display) and `npm run dist:verify` packaging checks.

### Changed
- Tests 81 → **116** (+35 regression tests covering all §14 categories).
- Memory estimates expose compute buffer separately with documented uncertainty; MoE total-weights vs active-compute nuance surfaced.
- Chat renders the most recent 200 messages (long-conversation responsiveness).

## [1.1.0] — 2026-11-24

Refinement release: engineering audit fixes, capability discovery, split/multimodal model support, remote endpoints, tri-state thinking, benchmark TTFT, dependency modernization. See REFINEMENT_REPORT.md for the full audit.

### Fixed
- **Five broken controls**: `window.prompt()`/`window.confirm()` are not implemented in Electron — scan-directory input, GGUF import, custom engine path, engine-version removal and conversation deletion now use in-app modal dialogs with full keyboard support.
- Ollama/Lemonade model registry listing in the launch form (was calling a non-existent bridge method).
- Scan-directory chips never rendered (`library:listScanDirs` was missing from the IPC surface).
- Chat markdown broke after the marked 15 → 18 upgrade (UMD global lost under bundling; fixed via ESM entry) — caught by browser verification.
- Performance dashboard's first sample never loaded (missing `monitor:sample` IPC).
- Assessment now accounts for **Windows commit-charge headroom** (a load fitting physical RAM can still fail on a near-full commit limit).

### Added
- **Engine capability discovery**: `--help`/`--list-devices` probing per binary; unsupported flags are never sent; probed capability report on engine cards (thinking format, KV types, flash attention, CPU MoE offload, mmproj, devices).
- **Status taxonomy**: available / compatible / experimental / not-installed / error with reasons — unverified acceleration never presented as functional.
- **Release-discovery resilience**: stable pointer → GitHub API → releases-page scrape → **HEAD-verified asset with walk-back through recent tags**; tag provenance logged; `.tar.gz` extraction (Linux builds).
- **Split GGUF support**: shard grouping, whole-group size/estimates, missing-shard warnings, shard badges.
- **Multimodal projector (mmproj)**: indexed, paired per model, passed via capability-gated `--mmproj`.
- **Thinking tri-state** (`auto/on/off`): explicit `think:false` for Ollama and `enable_thinking:false` for llama.cpp when disabled; config migration from the v1.0.0 boolean; "thinking…" indicator so reasoning never looks stalled.
- **Remote endpoints**: connect-only OpenAI-compatible servers (test, list models, chat) — persisted, never owned or stopped.
- **Benchmarks**: time-to-first-token, total response time, thread/GPU-offload/context/KV fields, JSON export.
- **Monitoring**: commit limit/used, pagefile allocated/used; assessment consumes commit headroom.
- **First-run onboarding** and UI loading states, ARIA labels, focus-visible outlines.
- **Real-engine E2E verification**: `tests/real-inference.js` drives actual llama.cpp b12359 + a real GGUF through the controller (spawns, streams, measures, terminates).

### Changed
- Electron 33.4.11 → **45.4.1**; electron-builder 25.1.8 → **26.18.0**; marked 15 → **18.3.0**; highlight.js → **11.12.0** (all renderer bundles re-vendored).
- `thinkingMode` param semantics: boolean → enum (transparent migration).
- Server records now carry the engine family for per-backend request dialects (`stream_options.include_usage` for llama.cpp only).

## [1.0.0] — 2026-11-24

Initial release.

### Added
- **Chat**: streaming responses with stop, regenerate, edit & resend; markdown with syntax-highlighted code blocks and copy buttons; separate thinking/reasoning display (llama.cpp `reasoning_content`, Ollama `reasoning`, `<think>` tags); token usage, generation speed, context utilization; text and image attachments; conversation history with full-text search; system prompts; per-conversation model badge.
- **Model Library**: recursive GGUF scanning of user directories; import-without-copy; GGUF v2/v3 metadata parser (architecture, quantization, layers, training context, MoE expert counts, tokenizer presence, license); quantization-aware sorting; memory estimation (weights + KV cache + overhead) with pre-load assessment (caution/warning/danger notes that inform but never block); favorites and categories; per-model configuration profiles; refresh without restart.
- **Inference Engines**: declarative descriptor registry with llama.cpp CPU/Vulkan/SYCL, Ollama and Lemonade built in; engine installation from official release artifacts into an isolated folder; multiple simultaneous versions; independent updates; one-click rollback via version activation; custom executable paths; user-contributed engines via `engines.d/*.json` without code changes; hardware compatibility detection with honest unknowns; per-engine default ports.
- **Server control**: start/stop/restart/switch models; configurable port and network binding (127.0.0.1 default, explicit 0.0.0.0 LAN mode); live log viewer with ring buffer + log files; duplicate-launch prevention (`DuplicateProcessError`); port-conflict detection with distinct external-process errors; strict managed/external process separation (Black Mirror never terminates processes it did not start); clean shutdown of all managed processes.
- **OpenAI-compatible serving**: model listing, chat completions, streaming, endpoint status, copyable addresses, connection info; every managed server is directly consumable by other local apps.
- **Performance dashboard**: live CPU/RAM/Windows-commit-charge (persistent PowerShell probe), GPU telemetry when `nvidia-smi` exists (honest n/a otherwise), managed-process RSS, uptime, pre-load resource assessment, sparkline charts.
- **Benchmark laboratory**: manual runs with repetitions; model load time, prompt processing t/s, generation t/s (server-reported and wall-clock), peak memory; results persisted and comparable; nothing fabricated.
- **Desktop app**: Electron 33 shell with single-instance lock, context-isolated preload API, obsidian/violet visual identity with original logo, responsive layout, preview mode for browser-only UI evaluation.
- **Packaging & ops**: electron-builder config (NSIS + portable), Windows setup scripts (`setup.cmd`, `setup-windows.ps1`), engine install CLI helper, config template, rotating diagnostic logs, atomic JSON stores with corruption fallback.
- **Tests**: 60 automated tests across 7 suites runnable without Electron (GGUF parser, estimator, library, registry/adapters/installer with mock network, controller with real process lifecycle + mock engine, ports, log parser, conversations, config, monitor, benchmark pipeline, streaming client).

### Security & privacy
- No accounts, no telemetry, no cloud calls — all inference and storage are local.
- API binding defaults to 127.0.0.1; LAN exposure is opt-in with an explicit warning.
- Uninstall is confined to Black Mirror's own data directory.
