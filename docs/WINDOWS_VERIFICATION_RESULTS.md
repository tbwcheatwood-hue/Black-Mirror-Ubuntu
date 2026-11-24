# Windows Verification Results — Black Mirror v1.2.1

Executed on real Windows 11 x64 hardware on 2026-11-24. This document records what was actually performed. Claims marked **PASS** were observed; items not attempted are listed separately.

## Hardware (measured)

| Item | Measured |
|---|---|
| OS | Microsoft Windows 11 Pro, build 26300, 64-bit |
| CPU | 12th Gen Intel Core i5-12500 (6C/12T) |
| RAM | ~55.7 GB physical (4 modules @ 3200 MT/s); ~33 GB free at inventory |
| GPU | Intel UHD Graphics 770, driver 32.0.101.7088 |
| Vulkan | `vulkan-1.dll` present; `vulkaninfo` on PATH (runtime present; Vulkan backend **not installed** during this validation) |
| Disk free (C:) | ~354 GB |

## Results summary

| Area | Result |
|---|---|
| Original ZIP integrity | **PASS** — `Black-Mirror-v1.2.0.zip` SHA256 `27187A55FD60E944E48542D33520D5BE99506A7F4344E4CBDC1C33ED69C6F162`, 124 entries, left unchanged |
| Black Mirror installation | **PASS** — extracted + rebuilt portable at `C:\BlackMirror\app` |
| Installed application version | **PASS** — v1.2.1 (package.json, UI brand, asar manifest) |
| Windows GUI launch | **PASS** — window title `Black Mirror — Local AI Studio`; Electron main + renderer init |
| Desktop shortcut | **PASS** — `Desktop\Black Mirror.lnk` → `C:\BlackMirror\app\Black Mirror.exe` (no autostart) |
| Primary model directory discovery | **PASS** — `C:\KayockModels` |
| FOXAI model directory discovery | **PASS** — `Z:\FOXAI\Models\Chat` (read-only index) |
| Total models discovered | **PASS** — 36 (incl. 2 mmproj) |
| Native inference engine installation | **PASS** — Black Mirror `EngineInstaller` → llama.cpp CPU `b12359` into `%APPDATA%\BlackMirror\engines\` |
| Installed inference engine version | **PASS** — build 12359 (`llama-server --version`) |
| Dynamic engine capability probing | **PASS** — thinking/jinja/mmproj/KV types/flash-attn/cpu-MoE probed |
| Windows hardware monitoring | **PASS** — PowerShell probes; Diagnostics snapshot collected |
| Real model loading | **PASS** — `unsloth.Q4_K_M.gguf` on port 18081 |
| Streaming chat | **PASS** — TTFT ~547 ms; reply “The answer is 4.”; ~9.2 tok/s approx |
| OpenAI-compatible API | **PASS** — `/v1/models` + `/v1/chat/completions` (stream + non-stream) |
| Model unloading | **PASS** — verified stop |
| Confirmed process termination | **PASS** — `confirmed=true`, `taskkillExit=0`, port released, HTTP down |
| Restart reliability | **PASS** — confirmed stop required; post-restart chat OK (pid changed) |
| Compatibility Lab | **PASS** — assess → `likely-compatible`; profiles advisory-only |
| Diagnostics Center | **PASS** — snapshot sections collected |
| Automated regression tests | **PASS** — **120/120** passed (0 failed, 0 skipped) |
| Windows portable rebuild | **PASS** — `Black Mirror-1.2.1-win.zip` + `dist:verify` 12/12 |
| FOXAI preservation | **PASS** — FOXAI `llama-server.exe` SHA unchanged; model mtime/size unchanged |
| Existing server preservation | **PASS** — no llama/FOXAI inference servers were running at start; none disturbed; port 18081 freed after test |
| GitHub repository | **BLOCKED** — `kayock/Black-Mirror` does not exist (HTTP 404); `gh` CLI unavailable at start of publication; see final report |
| GitHub commit SHA | pending publication |
| GitHub release tag | pending publication |
| Release download URL | pending publication |

## Source corrections applied in v1.2.1

See `docs/CHANGELOG.md` [1.2.1]. Highlights: restart confirmation gate; Windows ownership snapshots; GUI `dataDir` wiring; `server-log` IPC allowlist; Windows test/zip helpers; `verify-dist` asar path handling.

## Not claimed / not installed

- Vulkan and SYCL backends were **not** installed. Status remains `not-installed` (honest).
- Ollama / Lemonade not installed.
- No 30B/80B-class models loaded.
- No firewall / pagefile / system service changes.
- Z: drive and FOXAI trees were not modified.
