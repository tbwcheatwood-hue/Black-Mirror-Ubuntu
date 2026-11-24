# WINDOWS VERIFICATION — Black Mirror v1.2.1

Status: **in progress on real Windows 11 x64 hardware** (Intel Core i5-12500, Intel UHD 770, ~56 GB RAM). This document is the practical, isolated procedure for validating Black Mirror on a Windows 11 x64 machine **without touching any existing models, engine installs, services or configuration**. Everything below was designed so it can be executed by following it literally. v1.2.1 preserves the v1.2.0 baseline and adds the restart confirmation fix verified during this Windows install.

## 1. What has and has not been verified, honestly

| Area | Verified in dev sandbox (Linux) | Pending Windows validation |
|---|---|---|
| Process spawn/readiness/log capture | ✅ real llama.cpp b12359 | taskkill variant ⏳ |
| Verified termination (exit + port + HTTP) | ✅ POSIX paths | `taskkill /T /F` + port/HTTP checks ⏳ |
| Ownership records + crash recovery | ✅ incl. PID-reuse rejection | Win32_Process identity probe ⏳ |
| Capability probing (`--help`, `--list-devices`) | ✅ real binary | Windows binary behavior ⏳ |
| Staged engine install + validation + checksums | ✅ mock + real tree | `Expand-Archive` extraction ⏳ |
| PowerShell monitoring probe (commit/pagefile) | code inspection only | live PS ⏳ |
| Electron GUI (window, preload, IPC) | binary smoke + Chromium preview | windowed launch ⏳ |
| Packaging (dir + zip targets, asar markers) | ✅ built + verified | final executables ⏳ |
| Vulkan/SYCL acceleration | honest `experimental` states | driver-stack reality ⏳ |
| Ollama/Lemonade adapters | unit + mock | live services ⏳ |

Never claim Windows verification that did not occur: anything marked ⏳ above is unverified on Windows as of this release.

## 2. Isolated validation procedure (no impact on existing setups)

### Preparation
1. Use the portable build: extract `windows-portable/Black-Mirror-Portable-1.2.0.zip` (or the `win-unpacked` folder) to a **new folder**, e.g. `D:\bm-validate\app\`. The portable build writes all state next to itself (or to a per-user data dir) — it does not touch `Program Files`, registry or existing tools.
2. Confirm your existing inference servers (Ollama, llama.cpp, etc.) are running normally. Do not stop them — the point is to verify Black Mirror never disturbs them.

### Smoke sequence (~15 minutes)
3. Launch `Black Mirror.exe`. Expect the first-run onboarding; pick **Skip**.
4. **Settings → data location note**: all state (config, library index, engine installs, logs, compat results) lives under the app's data dir — note it in Diagnostics → Application.
5. **Inference Engines → Install llama.cpp (CPU)**. This downloads into Black Mirror's own engines folder. Existing engine installs elsewhere are untouched. Verify: staged download progress → validation → active version listed.
6. **Model Library → Add scan directory**: point it at a folder containing ONE small GGUF you own (or download a small one separately for testing). Files are indexed in place — verify timestamps/sizes unchanged after scanning.
7. **Compat Lab**: select the small model + llama.cpp CPU. Press **Assess** (expect likely-compatible) and **Run staged compatibility test** (expect all 7 stages green, incl. `terminate` reporting exit + port release).
8. **Servers → Launch**: launch the same model on a **dedicated port** (e.g. 8081 if free). Check the pre-load memory assessment text. Chat one prompt. Stop the server; confirm the toast and the log line `stop confirmed pid=… port released`.
9. **Ownership recovery**: while a server is running, kill Black Mirror from Task Manager (simulates a crash). Relaunch it: the server should appear as a **recovered managed process** (Diagnostics → Processes & endpoints). Stop it from the UI and confirm.
10. **Foreign-process protection**: start any OTHER inference server yourself (e.g. your existing Ollama). Restart Black Mirror. Diagnostics must list it as external/unverified if it collides with an old record — and the Stop button must NOT appear for it. Servers view shows only your managed server's Stop control.
11. **Diagnostics → Export report**: confirm a JSON file is written locally and contains the expected sections.
12. **Benchmarks**: run one short benchmark (512/64 tokens, 1 rep) on the small model; verify TTFT + t/s appear and export to JSON works.
13. **Shutdown cleanup**: quit Black Mirror while a server runs; verify the process exits (Task Manager) — `stopAll` outcomes are logged; unresolved terminations would be reported, not hidden.

### Acceleration validation (optional, UHD 770)
14. Install llama.cpp **Vulkan**; check the engine card's probed line for a device; run the Compat Lab staged test with acceleration `gpu-vulkan` on the small model. Record measured tok/s from a Benchmark run. Do not judge performance from a single run — repeat 3×.

### Success criteria
- All staged tests green; every stop reports "confirmed".
- No existing inference process or model file was modified (verify timestamps before/after).
- Recovery adopts only Black Mirror's own processes; foreign processes are classified external.

## 3. Known Windows-specific behaviors to watch

- First launch may trigger SmartScreen for the unsigned binary ("More info → Run anyway"). No certificate is embedded.
- `taskkill /T /F` is used for owned process trees only; failure produces an explicit `stop UNRESOLVED` warning — report it if seen.
- If Windows Defender real-time scanning delays the first `Expand-Archive`, the installer retries are logged; a failed extraction leaves the previous version active.
- Commit-charge warnings require a pagefile; systems with pagefile disabled will see commit headroom ≈ physical RAM.
