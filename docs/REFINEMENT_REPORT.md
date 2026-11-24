# REFINEMENT REPORT — Black Mirror v1.0.0 → v1.1.0

An independent engineering audit and refinement of the v1.0.0 submission, performed in the same isolated Linux development environment. Every fix was verified by the automated suite (`npm test`); every Windows-specific change is labeled as such. Baseline: v1.0.0 zip + git history (recoverable; the shipped v1.1.0 source was re-tested after extraction).

## 1. Original architectural strengths (preserved)

- **Testable plain-Node core** with zero Electron imports — carried through v1.1.0 without change; it is the reason 81 tests now run without a display or Windows.
- **Declarative engine descriptors + imperative adapters** — retained and extended (not rewritten) with capability probing and status taxonomy.
- **Strict ownership model** for processes, unchanged and additionally covered by tests.
- **Renderer-direct HTTP** to the local engine (no proxy hop), unchanged.
- **No cloud, no accounts, no telemetry** — unchanged.

## 2. Problems discovered in the audit

| # | Severity | Problem | Impact |
|---|---|---|---|
| P1 | **High** | `window.prompt()` / `window.confirm()` were used for scan-directory input, GGUF import, custom engine path, engine-version removal and conversation deletion. **Electron does not implement either API** — every one of those controls would throw at runtime. | Five visible controls were non-functional in the real desktop app (worked only in the browser preview). |
| P2 | High | Ollama "model list" in the launch form called a non-existent bridge method (`listOllamaModels`) and always rendered empty. | Ollama/Lemonade users could not pick registry models. |
| P3 | High | `library.listScanDirs` was never exposed over IPC/preload — scan-directory chips never rendered. | Scan dirs were invisible/unmanageable in the UI. |
| P4 | Medium | `servers:start` accepted no engine-family flag on the server record; the chat layer could not tell which API dialect a server speaks. | Blocked correct per-engine request behavior (e.g. stream usage). |
| P5 | Medium | Benchmark generation timing consumed the SSE stream via `res.text()` — no first-token measurement possible. | Benchmark lacked TTFT and total-response metrics. |
| P6 | Medium | Assessment only looked at physical RAM; a load fitting RAM could still fail on Windows when commit charge was near its limit. | Misleading "fits" verdicts on tight pagefile systems. |
| P7 | Medium | Engine argument mapping assumed every llama.cpp build supports every flag; older/newer builds with renamed or removed flags would fail to start. | Startup failures outside the reference build. |
| P8 | Low | `Monitor` sampled `committedTotal` = commit limit but never exposed used/limit or pagefile; naming was ambiguous. | Dashboard under-informative. |
| P9 | Low | `stream_options.include_usage` never requested — llama.cpp streamed responses had no token usage, so chat tok/s stats fell back to estimates. | Imprecise speed/context stats. |
| P10 | Low | "Invalid Date" rendering for engine versions without `installedAt`; `1 managed process(es)` pluralization. | Cosmetic. |
| P11 | Low | Linux llama.cpp release assets are `.tar.gz` but the installer only extracted `.zip`. | Linux/dev installs of engines would fail. |
| P12 | Low | Electron 33 was four major versions behind current stable (45.4.1); marked/highlight.js/electron-builder behind. | Aging dependency surface. |
| P13 | Low | Performance view's initial sample silently failed on the real bridge (`monitor:sample` IPC did not exist). | Blank dashboard for up to 2 s. |
| P14 | Low | Onboarding: first-run users had no guided path. | Weaker first-run experience. |

## 3. Bugs fixed (each with a regression test)

- **P1** → `uiPrompt()` / `uiConfirm()` modal replacements (renderer/js/views/settings.js) + all five call sites migrated; `uiConfirm` used for destructive actions only.
- **P2** → real `servers:engineModels` IPC (`adapter.listModels`) wired for Ollama (`/api/tags`) and Lemonade (`/api/v1/models`); launch form populates from the live service or explains why it cannot.
- **P3** → `library:listScanDirs` IPC + preload + mock; chips render.
- **P4** → `family` recorded on the managed server record and surfaced in `_public()`.
- **P5** → benchmark generation now consumes the SSE stream incrementally and records **TTFT** and **total response time** (tests/v11.test.js asserts both).
- **P6** → assessment consumes `commitFreeBytes` (Windows commit headroom) with two new warning levels (tests/v11.test.js).
- **P7** → `capabilities.probe()` runs `--help`/`--list-devices` once per binary and `LlamaCppAdapter` emits only flags the binary knows (tests/v11.test.js: both gated and legacy-unknown behavior).
- **P9** → `stream_options: { include_usage: true }` sent for llama.cpp-family servers only (other backends untouched).
- **P10** → defensive date rendering; pluralization fixed.
- **P11** → `.tar.gz` extraction support (tar on POSIX, PS Expand-Archive for zip on Windows).
- **P13** → `monitor:sample` IPC + immediate sample pull.

## 4. New functionality

- **Engine capability discovery** (`main/engines/capabilities.js`): probes the real binary (`--help`, `--list-devices`), caches per mtime, maps to a UI capability report (thinking format, KV-cache types, flash attention, CPU MoE offload, mmproj, detected devices) — **verified against the actual llama.cpp b12359 binary** (see §7).
- **Engine status taxonomy**: `not-installed / available / compatible / experimental / error` with a reason string — acceleration methods are never presented as functional without evidence (SYCL without Level Zero is `experimental` with an honest explanation).
- **Release-discovery resilience**: strategy chain = explicit tag → stable pointer (`nightly-tag.txt`) → GitHub API latest → releases-page scrape → **asset HEAD verification with walk-back through recent tags** when an asset is missing; tag/asset provenance (`via`) logged and reported. No hardcoded versions or asset assumptions beyond the descriptor templates.
- **Split GGUF support**: shard detection (`-00001-of-00003`), per-group size sums, incomplete-shard warnings, whole-group weight memory in estimates, shard badges in the UI.
- **Multimodal projector (mmproj) support**: projector files indexed as first-class library entries, candidates suggested per model (same directory/base), `--mmproj` passed (capability-gated).
- **Thinking tri-state** (`auto/on/off`): Ollama gets explicit `think:false` when disabled (required for models that think by default — omission is not enough); llama.cpp gets `--reasoning-format deepseek` when enabled and `chat_template_kwargs:{enable_thinking:false}` when disabled; `auto` leaves engine defaults. Config migrates the v1.0.0 boolean automatically. The chat shows a "thinking…" state while reasoning streams before content, so reasoning never looks like a stalled response.
- **Remote endpoints**: connect to existing local/remote OpenAI-compatible servers (`servers:addRemote/testRemote/removeRemote`, persisted registry). Remotes are listed, testable, chat-capable — and can never be stopped or launched by Black Mirror (ownership model extended to endpoints, covered by tests).
- **Benchmark upgrades**: TTFT, total response time, thread/GPU-offload/context/KV configuration fields, JSON export, richer labels for comparisons.
- **Monitoring upgrades**: commit limit + used, pagefile allocated/used (Windows `Win32_PageFileUsage`), Linux `CommitLimit`/swap approximation on dev machines.
- **First-run onboarding**: a dismissible 3-step guide (engine → models → launch) gated by `firstRunDone` config.
- **UI**: status badges per engine category, probed-capability line on engine cards, split/mmproj badges, pagefile/commit cards, loading states on engine install, focus-visible outlines, ARIA labels/dialog roles on modals and toasts, "Connect to endpoint" flow with test-first UX.

## 5. Dependencies updated

| Package | v1.0.0 | v1.1.0 | Notes |
|---|---|---|---|
| electron (dev) | 33.4.11 | **45.4.1** | current stable; contextBridge/preload API unchanged for our usage; verified via binary smoke check + renderer preview |
| electron-builder (dev) | 25.1.8 | **26.18.0** | matches newer Electron packaging |
| marked | ^15.0.7 | **18.3.0** | renderer vendored bundle rebuilt |
| highlight.js | ^11.11.1 | **11.12.0** | vendored bundle rebuilt |
| esbuild (dev) | 0.24.2 | unchanged | still does the vendor bundling |

No new runtime dependencies were added — the renderer remains vanilla JS.

## 6. Architectural changes

- **Additive, not a rewrite.** The module map from v1.0.0 is intact; one new module (`engines/capabilities.js`), one new descriptor field family (`probedCapabilities`, `statusCategory`), one new persisted store (`remotes.json` inside the controller), and two new parameter types (`path`, `string`) in `PARAM_SCHEMA`.
- `PARAM_SCHEMA` is now the single source for launch form, settings, and benchmark overrides (tri-state thinking, CPU MoE offload, mmproj, extraArgs).
- `ServerController.list()` merges connect-only remote endpoints with managed processes; `mode: 'remote'|'managed'` is explicit everywhere.
- Capability probing result is injected into adapters so **flag emission is decided by evidence, not assumptions**.

## 7. Verification highlights (this environment)

- **Real inference end-to-end (new in v1.1.0):** the actual llama.cpp `b12359` Linux binary was spawned by Black Mirror's `ServerController` with a real GGUF model (ggml-org `stories15M-q4_0`), reached health in 571 ms, capability probe reported `thinking/jinja/flash-attn/cpu-moe = true`, a genuine streamed completion ("One day, the sky got dark…") arrived with **TTFT 44 ms**, and `controller.stop()` terminated the process (verified by PID). Script: `tests/real-inference.js`. This is Linux CPU execution — Windows behavior remains unverified (§9).
- Full suite: **81 tests, 81 passing** (was 65). See TEST_REPORT.md for the categorized breakdown.

## 8. Performance improvements, where measured

- `stop()` on a signal-killed process: **~15.1 s → ~56 ms** (fixed in v1.0.0 already, regression-covered here).
- Library refresh unchanged (mtime+size cache) — no regression (suite timing similar).
- Real-engine load through the controller: 571 ms spawn→ready for a 19 MB model (2-core dev sandbox).
- No fabricated performance claims; benchmark numbers always come from real requests.

## 9. Windows-specific verification still required

- `taskkill /T /F` tree cleanup (code unchanged from v1.0.0; still only inspectable, not executable here).
- PowerShell probe (commit/pagefile/working sets) against a live PS.
- `Expand-Archive` for engine zips.
- Electron 45 window/preload startup on Windows (renderer verified in Chromium 158 headless).
- Vulkan/SYCL behavior under the user's driver stack; Ollama/Lemonade installers.
- NSIS installer roundtrip (needs wine locally or a Windows machine).

## 10. Remaining limitations

1. Intel iGPU per-process telemetry remains `n/a` (no vendor API) — shown honestly.
2. Embeddings UI still absent.
3. mmproj auto-pairing is heuristic (directory + name prefix), not metadata-driven.
4. Electron shell itself was not launched headlessly (no X server); verified via binary smoke + full renderer preview.
5. Single window, single config store — multi-profile support remains future work.

## 11. Recommended future improvements

- Wire llama.cpp `--list-devices` output into the launch form as an offload-target picker (data model already there).
- Convert the benchmark comparison table into cross-run diff highlighting (data model already supports it).
- Optional model download integration (HuggingFace direct) with explicit user intent — out of scope for v1.1.0 by design.
- i18n.

## 12. v1.0.0 → v1.1.0 comparison

| Dimension | v1.0.0 | v1.1.0 |
|---|---|---|
| Automated tests | 65 | **81** (+16 regression tests incl. capability/splits/remotes/TTFT/commit) |
| Real-engine E2E | none | **yes** (llama.cpp b12359 + real GGUF, streamed, measured, cleaned up) |
| Electron | 33.4.11 | **45.4.1** |
| Working UI controls | 5 broken (prompt/confirm) | **all functional** (modal-based) |
| Engine capability reporting | descriptor-declared | **probed from the binary** (`--help`, `--list-devices`) |
| Engine status taxonomy | available/not-installed/error | available / compatible / **experimental** / not-installed / error + reason |
| Release resolution | pointer + one fallback | 4-strategy chain + **asset verification with tag walk-back** |
| Split GGUF | no | detection, group sizing, incomplete warnings |
| Multimodal | `image_url` chat only | + mmproj indexing, pairing, launch wiring |
| Thinking control | boolean | **tri-state** with explicit disable for Ollama/llama.cpp |
| Remote endpoints | — | connect-only, persisted, testable, never owned |
| Benchmarks | load/prompt/gen/memory | + **TTFT**, total time, config fields, JSON export |
| Monitoring | CPU/RAM/commit | + commit used/limit, pagefile usage |
| Onboarding | none | first-run guided setup |


---

# Addendum — v1.2.0 audit findings

The v1.2.0 production-readiness audit (full report: PRODUCTION_READINESS.md) surfaced three defects this document's v1.1.0 audit missed:

1. **The distributed v1.1.0 source could not rebuild the app**: the release manifest lost its `scripts` and `devDependencies` (the surviving lockfile proves the toolchain existed in the working tree but was never committed). Correction: complete manifest + explicit electron-builder config + lockfile-sync and script-reference regression tests; `npm ci` verified end-to-end.
2. **`stop()` conflated "kill requested" with "process exited"**: termination is now verified (exit observed, port released, endpoint silent) and unresolved states are reported honestly — the challenge's hypothesis was confirmed by code inspection and regression-tested.
3. **`.gitignore` rule `engines/` silently excluded `main/engines/` from every commit** — the source of the engine subsystem existed only in release archives, not in version control. Discovered when the environment restore dropped the directory and git reported nothing missing. Correction: pattern anchored to `/engines/`, source restored from the shipped archive and committed. Lesson applied: release verification now includes manifest + tree-integrity checks (`dist:verify`, manifest tests).

The v1.1.0 sections above remain accurate for that release.
