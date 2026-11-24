# PRODUCTION READINESS — Black Mirror v1.2.0

An independent production-readiness audit of v1.1.0 → v1.2.0, performed in the isolated Linux development environment. Every corrected defect has a regression test; every claim is scoped to what was actually executed.

## 1. Problems independently discovered in v1.1.0

| # | Severity | Problem | Root cause |
|---|---|---|---|
| PR1 | **Critical** | The distributed source `package.json` had **no `scripts` and no `devDependencies`** — none of the documented commands (`npm test`, dev launch, Windows build) could run from the shipped source. Also **no committed electron-builder config** existed; the v1.1.0 build relied on implicit defaults. | The dev-tooling state that existed in the working tree during v1.1.0 development was never captured in the release commit/manifest (surviving lockfile proves the packages were installed). Release process lacked a manifest check. |
| PR2 | **Critical** | `stop()` reported success without confirming termination: it awaited `taskkill`'s own exit (not the process's death), never verified port release or endpoint silence, and returned `true` unconditionally. | Lifecycle code conflated "kill requested" with "process exited". |
| PR3 | **High** | **`main/engines/` was missing from every git commit** — the `.gitignore` rule `engines/` (written for runtime install dirs) also excluded the source directory. Version control could not restore the application. | Unanchored gitignore pattern + no pre-commit verification that the tree matches the release. |
| PR4 | High | No recovery after app crash: an inference process survived the app with no ownership trail; a naive PID/port match on next start could have adopted or killed an unrelated process. | Ownership was only in-memory. |
| PR5 | Medium | Engine installs extracted directly onto the destination; a failed update could damage a working install. No disk-space guard, no checksum support, no post-extract validation. | Non-staged install flow. |
| PR6 | Medium | Assessment ignored compute buffers as a separate line item and did not state estimate uncertainty; MoE total-vs-active nuance not surfaced. | Estimate presentation. |
| PR7 | Medium | Benchmarks lacked comparability metadata — results from different engine versions/threads/context looked comparable when they were not. | Missing result fields. |
| PR8 | Low | Long conversations rendered every message (slow at 1000+); model bridge mock version string stale; server logs unbounded in long sessions. | Render/cap hygiene. |
| PR9 | Low | Mock-bridge and preview surfaces drifted from the real IPC (missing lab/diagnostics/profiles methods). | Mock not versioned with IPC. |

## 2. Defects corrected (all with regression tests)

- **PR1** → complete manifest: 10 functional scripts (`setup`/`vendor`/`test`/`test:real`/`test:electron`/`start`/`dev`/`build:win`/`build:portable`/`dist:verify`), devDependencies (electron ^45.4.1, electron-builder ^26.18.0, esbuild ^0.24.2), **explicit electron-builder `build` config** (appId, files whitelist, win targets dir+zip), lockfile-sync test, "every script references an existing file" test, dev-vs-production manifest distinction documented and tested. `npm ci` verified to restore the exact toolchain from the lockfile.
- **PR2** → `stop()` now: kills, then **verifies exit** (polls process death), then checks **port release** (TCP probe) and **endpoint silence** (HTTP probe), and returns a detailed verdict `{confirmed, exitObserved, pidAliveAfter, portReleased, httpDown}`. `stopAll()` returns per-process outcomes and lists unresolved ids instead of clearing blindly. Tests: confirmed stop (real process), sabotage-kill honest failure, stopAll outcome summary.
- **PR3** → `.gitignore` anchored to `/engines/`; `main/engines/` restored from the shipped v1.1.0 archive and committed (9 files). Git tree now contains the full application.
- **PR4** → new ownership layer (`main/server/ownership.js` + persisted `managed-processes.json`): every spawn records exe path, model path, process start time. `recoverAtStartup()` classifies each record: dead → cleared; **identity verified** (exe + model-in-cmdline + start time) → adopted as stoppable `recovered` process; unverifiable → **external, never terminated**, surfaced in Diagnostics. PID-reuse protection via start-time match. Tests: verified adoption + stop, foreign-process rejection, start-time-mismatch rejection, dead-record clearing.
- **PR5** → staged installs: disk-space guard (`fs.statfsSync`), download → `.staging-<tag>` → checksum (when the descriptor publishes one) → extraction → **binary validation** (`_validateStaged`) → atomic move → activate. A failed update never touches the previous version (staging discarded; old tree kept until the replacement validates). Tests: disk-space rejection, checksum accept/reject/absent-source, staged validation.
- **PR6** → `estimate.js` exposes `computeBufBytes` separately, an explicit `uncertainty` statement, MoE `moeActiveVsTotal` note, mmproj allowance; assessor distinguishes file size vs memory estimates vs measurements everywhere.
- **PR7** → benchmark results carry a `comparability` block (engine version, acceleration, model file, threads, context, KV, offload, prompt/gen tokens); the UI explains that only full-key matches are directly comparable.
- **PR8** → chat renders the most recent 200 messages with an explicit notice; log ring capped at 800 lines/process; mock version string corrected.
- **PR9** → mock bridge implements the complete v1.2.0 IPC surface (lab, profiles, diagnostics, enginesExtra).

## 3. New production-readiness features

- **Compatibility Lab** (see COMPATIBILITY_LAB.md): model/engine inspection with confirmed-vs-estimated-vs-unknown labeling, honest 6-state compatibility assessment, manually initiated staged tests with verified termination, persistent results with staleness invalidation.
- **Diagnostics Center**: one-click local snapshot (app/OS/hardware/engines/models/processes/endpoints/port conflicts/recent errors/compat results/memory) with plain-language troubleshooting hints (outdated engine, unsupported arch, unsupported flag, missing runtime, insufficient memory, invalid file, missing shard, missing projector, occupied port, startup failure, connectivity failure) and local JSON export. Nothing is transmitted anywhere.
- **Recommended launch profiles**: 7 goals generated from detected hardware, model metadata and probed capabilities — advisory only, clamped to the model's training context, omitting unsupported parameters, documenting assumptions, applied only by explicit user action.
- **Update checking** (`engines:checkUpdate`) using the existing no-credentials release chain; the result distinguishes "up to date", "newer available", and "discovery failed (reason)".

## 4. Performance measurements

- Library refresh unchanged: metadata cache keyed by mtime+size (no re-scan regressions; suite timing stable at ~42 s for 81 tests before expansion).
- Capability probe caching: per-binary, keyed by mtime — repeated engine views do not re-spawn probes (verified by suite timing and code path).
- Chat render cap: rendering is bounded at 200 bubbles regardless of history length (test: conversation persistence unaffected; UI check in browser).
- Real-engine load through the controller: stories15M ready in <1 s; qwen2.5-0.5B (640 MB Q8_0) ready in ~20–40 s on the 2-core sandbox; 3 full load→unload cycles with verified stops completed without leaks (PIDs recycled cleanly).
- Electron startup performance: not measurable here (no display); GUI launch attempt documented in TEST_REPORT as skipped-honestly.

## 5. Expanded test coverage

81 (v1.1.0) → **116 automated tests** across 10 files, plus two real-process scripts:

- manifest reproducibility (5 tests), verified termination (3), ownership/recovery (5), install staging/checksums/disk (3), compatibility assessment (6), lab persistence/staleness (2), profiles (3), estimate transparency (2), diagnostics (2), electron runtime smoke (3, GUI launch skips honestly without a display).
- `tests/real-inference.js` (single-model E2E, carried from v1.1.0) and `tests/real-inference-v2.js` (expanded: 2 architectures, 2 quantizations, 2 context configs, streaming + TTFT, mid-stream cancellation ×2, restart, model switching, 3 verified load/unload cycles, thinking request shapes, ownership-record cleanup) — **12/12 checks passed** on Linux CPU.

Test taxonomy is documented in TEST_REPORT.md §7b/§9.

## 6. Packaging corrections

- Source manifest vs production manifest are now distinct and tested: production (`app.asar`) carries only `main/**`, `renderer/**`, `assets/icon.png`, pruned `package.json` (no scripts/devDeps — asserted by `dist:verify`).
- `scripts/verify-dist.js`: PE header check, asar v1.2.0 markers, packaged-version check, production-manifest pruning check, vendor-bundle presence.

## 7. Remaining limitations

1. No display in the sandbox: Electron GUI launch verified only via binary smoke (`ELECTRON_RUN_AS_NODE`) and Chromium preview; a real windowed launch is documented as pending in WINDOWS_VERIFICATION.md.
2. NSIS/portable single-exe targets require wine on Linux; the `dir`+`zip` targets are produced here.
3. MoE real inference not exercised (no appropriately small public MoE GGUF); MoE behavior covered by unit tests (estimates, profile generation, adapter args).
4. Windows-only paths (taskkill, PowerShell probes, Expand-Archive) remain inspection-verified — code unchanged in v1.2.0 except where new (staging validation works on both platforms).
5. Ollama/Lemonade staged tests reuse their own model registries; the ladder's load stage for them depends on the service being up.

## 8. Known risks

- Capability probing executes `--help` on engine binaries — standard practice, but any engine descriptor a user adds is executed once at status time. Descriptors live in `engines.d/` and are user-controlled.
- Recovery adopts a process only on three-factor identity match; a malicious process that forges all three (exe path + cmdline model path + start time) is outside the threat model (local trusted user).
- Checksums exist only when a descriptor publishes a source; llama.cpp currently publishes none — integrity for those assets rests on extraction validation, documented in the installer.

## 9. Recommended Windows validation procedure

See WINDOWS_VERIFICATION.md for the isolated, non-destructive procedure (portable dir, dedicated data dir, dedicated ports, own engine copies — never touching the user's existing models, installs or services).

## 10. v1.0.0 → v1.1.0 → v1.2.0 comparison

| Dimension | v1.0.0 | v1.1.0 | v1.2.0 |
|---|---|---|---|
| Automated tests | 65 | 81 | **116** |
| Real-process / real-inference scripts | none | 1 (12 checks? no — 1 scenario) | **2 scripts, 12/12 checks incl. 2 architectures, cancellation, cycles** |
| Distributed build reproducibility | docs only, no manifest | manifest still incomplete | **complete manifest + lockfile sync + build config + reproducibility tests** |
| stop() semantics | fire-and-forget true | fire-and-forget true (regression-caught in v1.2 audit) | **verified termination + honest unresolved reporting** |
| Crash recovery / ownership | in-memory only | in-memory only | **persisted identity + recovery with PID-reuse protection** |
| Engine update safety | overwrite-in-place | asset verification | **staged, validated, checksum-capable, old version preserved** |
| Compatibility guidance | engine cards | probed capabilities + status taxonomy | **dedicated Lab: assessment, staged tests, persisted verdicts, staleness** |
| Profile recommendations | manual params | manual params | **7 generated goals, explicit apply, documented assumptions** |
| Diagnostics | logs only | logs + perf view | **Diagnostics Center + export + troubleshooting hints** |
| Git integrity | engines source missing from VCS | same | **full tree committed, gitignore anchored** |
