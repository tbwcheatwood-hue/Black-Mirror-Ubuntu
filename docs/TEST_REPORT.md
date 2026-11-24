# TEST REPORT — Black Mirror v1.0.0

This report distinguishes strictly between what was **implemented and verified**, what is **implemented but unverified on Windows hardware**, what is **mocked**, and **known limitations**. Nothing in the "verified" column was performed on physical Windows hardware — the development environment was an isolated Linux sandbox — and every claim below states its platform.

## 1. Automated test suite — executed and verified (Linux sandbox)

`npm test` runs **116 tests in 10 files** via `node --test`. Result at release time:

```
tests 116   pass 113   fail 0   skipped 3 (Electron GUI launch — no display)   duration ~63s
```

> v1.1.0 shipped 81; v1.2.0 adds 35 (manifest reproducibility, verified termination + sabotage, ownership/recovery + PID reuse, install staging/checksum/disk, compatibility assessment + staleness, profiles, estimate transparency, diagnostics, Electron runtime smoke).

> v1.0.0 shipped 65 tests; v1.1.0 adds 16 (capability discovery, help-gated flag emission, split GGUF grouping, release-asset fallback walk-back, remote endpoints incl. persistence and refusal-to-stop, benchmark TTFT, commit-charge assessment, Ollama explicit think:false).

| Suite | Tests | What they verify |
|---|---|---|
| `gguf.test.js` | 16 | GGUF v2/v3 parsing (all KV value types incl. arrays/u64/bool), bad magic, truncated files, unsupported versions; summarize (architecture, quant, MoE, context, tokenizer); memory estimation math (KV bytes exact, bpw table, param estimate); assessment levels ok/caution/warning/danger with honest notes; MoE & large-context notes |
| `library.test.js` | 6 | Directory scanning (skips hidden/non-gguf), import-without-copy (byte-identical proof), invalid-file listing with readable errors, refresh add/drop, favorites/categories/filters, profiles, memory estimates through the library |
| `engines.test.js` | 20 | Descriptor loading (5 built-ins), version registration/multi-version/activation/rollback, unknown-engine errors, status snapshots (not-installed guidance, custom path), llama.cpp arg mapping (**context length passes through exactly** — the anti-silent-reduction invariant), all parameter→flag mappings, request overrides, version-string parsing (real llama-server output format), missing-binary errors with guidance, Ollama `num_ctx` exactness + `think` flag + `/api/tags` listing, Lemonade serve args + listing, installer: stable-pointer tag resolution, mock download → extract → register → already-installed no-op → uninstall (refuses paths outside engines dir), explicit tag override, unknown-family rejection |
| `controller.test.js` | 11 | Port in-use/free detection; **real process lifecycle against a live mock engine**: start→ready→logs captured→stop→pid terminated; duplicate-launch prevention (`DuplicateProcessError`); same-port-different-model refusal; external port conflict fails fast; restart keeps config; `stopAll` kills everything spawned; crashed engine → startup failure with log excerpt and non-blocked relaunch; readiness timeout → informative error, process kept for inspection; stop refuses unknown IDs; log parser (real llama-server timing lines, ready detection, load time) |
| `core.test.js` | 6 | Conversations (create/append/auto-title/edit/truncate/search/delete), config persistence across reloads + effective-params merge, monitor sample structure + honest GPU reporting, managed-process RSS on Linux |
| `bench.test.js` | 1 | Full benchmark pipeline against the mock engine: load time, prompt t/s, generation t/s, peak RSS sampling, aggregation, persistence, removal. **Explicitly labeled: verifies the measurement pipeline, not real-inference numbers** |
| `streamclient.test.js` | 5 | SSE parsing against a real HTTP server: delta accumulation, `reasoning_content` + `reasoning` channels, `<think>` tag stripping (incl. mid-chunk close — found and fixed a real bug here), usage capture, abort mid-stream, HTTP error surfacing, non-streaming `complete()` |

Tests run without Electron, Windows, displays, or network. The process-lifecycle tests spawn **real OS processes** (a Node-based mock engine speaking the OpenAI SSE protocol) and verify actual termination.

## 2. Verified in the sandbox beyond unit tests

- **Renderer UI end-to-end in headless Chromium** (agent-browser): all seven views render from the production HTML/CSS/JS; a staged conversation streams through the mock bridge and renders markdown, thinking disclosure, token stats and server badge; screenshots captured for every view (see `docs/screenshots/`). The preview banner is clearly labeled — the same UI code path runs in Electron.
- **Engine installer flow with mock network**: stable-pointer tag resolution (`nightly-tag.txt` → `b12359`), asset URL templating matching the real release naming (`llama-b{TAG}-bin-win-vulkan-x64.zip`), zip download+extract+register roundtrip — all against a local server serving a real zip archive.
- **Release-research verification**: latest engine releases resolved live via GitHub redirect headers (llama.cpp stable pointer v1.0.0→b12359 with confirmed asset names, Ollama v0.40.17, Lemonade v2026.47.1).

## 3. Implemented but NOT verified on Windows (requires physical Windows hardware)

These code paths are implemented, syntax-checked, and exercised where possible on Linux, but the Windows-specific branches were **not executed**:

| Feature | Windows-specific part | Status |
|---|---|---|
| Engine installation | `Expand-Archive` extraction via PowerShell | implemented; tested equivalent with `unzip` on Linux; PS syntax verified by inspection only |
| Process termination | `taskkill /PID x /T /F` tree kill | implemented; not executed on Windows (Linux path uses SIGTERM/SIGKILL and was verified) |
| Hardware probes | persistent PowerShell sampling loop (commit charge, per-PID working sets) | implemented; never run against a real PowerShell |
| GPU detection | `nvidia-smi` / `vulkaninfo` probes | implemented; probes return honest nulls in sandbox |
| External process listing | `Get-Process` PowerShell | implemented; Linux `ps` path verified |
| Electron app startup | window creation, preload, IPC | implemented; not launched (no display in sandbox; `soffice`-style rendering doesn't apply to Electron). Renderer verified in plain Chromium instead |
| Windows packaging | `electron-builder` NSIS/portable | attempted in sandbox — see §5 |
| Ollama/Lemonade live serving | real engine binaries | not bundled (by design); connect flows covered by adapters' tests with fake HTTP |

## 4. Mocked tests (clearly labeled)

- The **mock engine** (`tests/helpers/mockengine.js`) emulates `/health`, `/v1/models`, `/api/tags` and OpenAI chat completions with SSE. All controller/bench/stream tests use it. It verifies *Black Mirror's* logic, not engine behavior.
- The **preview bridge** (renderer) simulates engines/models/chat for browser-only UI preview; it is banner-labeled in the UI and never used by the Electron runtime.
- Benchmark numbers produced by mock tests verify the pipeline only. No performance claim in the docs is derived from mock data.

## 5. Windows packaging attempt (sandbox)

- `npm install` on Linux succeeded, including Electron 33.4.11 and esbuild-based renderer bundling.
- `npx electron-builder --win dir --x64` (cross-build to an unpacked Windows distribution) — **attempted; result recorded in the build log** (`docs/BUILD_LOG.txt`). Cross-building the NSIS installer from Linux requires wine (not available in the sandbox); on Windows, `npm run build:win` needs nothing extra. BUILD.md documents the fallback (`build:dir` → zip `win-unpacked\`).

## 6. Features requiring physical Windows hardware

- Actual inference speed of llama.cpp CPU/Vulkan/SYCL on the i5-12500 / UHD 770.
- Vulkan/SYCL device availability under the user's actual driver stack.
- Ollama/Lemonade installer behavior on Windows.
- Installer (NSIS) install/uninstall roundtrip.

## 7. Known limitations (product-honest)

1. **Multimodal images**: `image_url` parts are sent for multimodal models (Ollama vision models); llama.cpp `--mmproj` flows are not first-class yet (reachable via extra args).
2. **GPU telemetry**: Intel iGPU per-process utilization has no standard user-space API; the dashboard shows `n/a` with an explanation rather than invented values. NVIDIA works via `nvidia-smi`.
3. **SYCL**: without Intel compute runtime the serve attempt fails with a clear log error — reported honestly, not hidden.
4. **Embeddings**: engines support them; Black Mirror does not surface an embeddings UI yet.
5. **Electron shell startup** could not be launched in the sandbox (headless Linux without X); UI verified via Chromium, core verified via tests.
6. **Single-window UI**: multi-window support and per-window server binding are not implemented.
7. **Conversation files** are plain JSON — fine for typical usage, not optimized for tens of thousands of messages per conversation.

## 7a. v1.2.0 additions to verification

- **Real inference expanded** (`tests/real-inference-v2.js`): stories15M Q4_0 (llama arch) + qwen2.5-0.5B Q8_0 (qwen2 arch) through the controller — 12/12 checks: streaming TTFT (12 ms / ~130 ms), mid-stream cancellation on BOTH models, restart with preserved config, model switching A→B, 3× load→unload cycles with verified stops, explicit thinking-off request shapes, ownership-record cleanup. **Linux CPU; not Windows verification.**
- **Electron runtime** (`tests/electron-runtime.test.js`): binary executes JS (ELECTRON_RUN_AS_NODE); the entire main-process module graph loads error-free under the real Electron binary; GUI launch attempt **skipped honestly** in the sandbox (no display) — documented in WINDOWS_VERIFICATION.md.
- **Packaging verification** (`npm run dist:verify`): PE header, asar v1.2.0 markers (capabilities.js, compatlab/lab.js, profiles.js, diagnostics.js, re-vendored bundles), packaged-manifest version, production-manifest pruning.
- Manifest reproducibility tests prevent a recurrence of the v1.1.0 packaging defect (scripts/devDeps/build-config, lockfile sync, script file references).

## 7b. v1.1.0 additions to verification

- **Real-inference E2E** (`tests/real-inference.js`): actual llama.cpp b12359 Linux binary + real GGUF (stories15M Q4_0) driven through `ServerController`: spawn → health (571 ms), capability probe (thinking/jinja/flash-attn/cpu-moe all true), genuine streamed completion (TTFT 44 ms, 48 chunks), clean stop (PID verified dead). **Platform: Linux CPU. Windows remains unverified.**
- **Browser UI verification after every change** (headless Chromium): caught and fixed the marked 18 bundling regression (assistant responses rendered empty) before release.
- Electron 45 binary smoke-checked via `ELECTRON_RUN_AS_NODE`; renderer exercised in Chromium 158.

## 8. Bug found & fixed during verification

- SSE `<think>` handling dropped reasoning text when the closing tag arrived in the same chunk (caught by `streamclient.test.js`, fixed in `renderer/js/streamclient.js`).
- `ServerController.stop()` waited a full 15 s on signal-killed processes because `child.exitCode` stays `null` when killed by signal (caught by controller tests, fixed to await the `exit` event).
- GGUF test helper + parser edge cases (array materialization limits, `mostly q4_K_M` bpw normalization) — caught and fixed during test-driven development.
