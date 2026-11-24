# ENGINE COMPATIBILITY

Status of every engine Black Mirror ships descriptors for, what it supports, and what is honestly **not** claimed. Version facts below were verified against the projects' public releases during development (llama.cpp stable pointer `v1.0.0 → b12359`; Ollama v0.40.17; Lemonade v2026.47.1).

Reference hardware: **Windows 11 · Intel Core i5-12500 · 44 GB RAM · Intel UHD 770 (no discrete GPU)**.

---

## Capability discovery (v1.1.0)

Black Mirror no longer assumes what an engine supports: for llama.cpp builds it probes the installed binary itself (`--help`, `--list-devices`), caches the result, and **only sends flags the binary actually knows**. The Inference Engines view shows the probed capability line (thinking format, KV-cache types, flash attention, CPU MoE offload, mmproj, detected devices). Ollama and Lemonade report their fixed API surfaces.

Status taxonomy: **available** (works anywhere) · **compatible** (works, acceleration runtime confirmed present) · **experimental** (binary works, acceleration runtime unverified on this machine — serve may fail with a clear error) · **not-installed** · **error**. An acceleration method is never presented as functional without evidence.

## Support matrix

| Engine | Install | Multiple versions | Update / rollback | Models | Thinking | Images | API surface | Default port |
|---|---|---|---|---|---|---|---|---|
| **llama.cpp CPU** | ✅ auto (release zip) | ✅ | ✅ | your GGUF files | ✅ `--reasoning-format deepseek` | ❌ (mmproj builds not wired yet) | native OpenAI-compatible | 8081 |
| **llama.cpp Vulkan** | ✅ auto | ✅ | ✅ | your GGUF files | ✅ | ❌ | native OpenAI-compatible | 8082 |
| **llama.cpp SYCL** | ✅ auto | ✅ | ✅ | your GGUF files | ✅ | ❌ | native OpenAI-compatible | 8083 |
| **Ollama** | ⚠ official installer | ✅ (its own) | via Ollama | Ollama registry (`/api/tags`) | ✅ `think` flag | ✅ | OpenAI-compatible `/v1` | 11434 |
| **Lemonade** | ✅ auto (embeddable zip) | ✅ | ✅ | Lemonade registry + GGUF via llama.cpp backend | ❌ (model-dependent, not auto-detected) | ❌ | OpenAI-compatible `/api/v1` | 8000 |
| **custom / future engines** | ✅ custom executable path | — | — | GGUF-path or registry | if the API provides it | if the API provides it | any OpenAI-compatible | any |

## Hardware compatibility details

### llama.cpp CPU — **recommended default on the reference machine**
- Requires: any x64-64 Windows. No driver requirements.
- i5-12500 (12 threads): 6 performance cores + Efficient cores; `threads: 6` (P-cores) is a good starting point, 8–10 often helps with larger models until memory bandwidth saturates.
- Supports AVX/AVX2 builds shipped in the official release zips.
- Memory: 44 GB comfortably serves 14B Q4–Q8, 22–32B Q4, and MoE models like Qwen3-30B-A3B (≈18.6 GB Q4_K_M) with headroom for context. The pre-load assessment estimates this before launch.

### llama.cpp Vulkan
- Requires: Vulkan 1.1+ driver. Intel UHD 770 exposes Vulkan via the standard Intel graphics driver (driver version dependent, generally fine on any Windows 11 system kept updated).
- **Honest expectation setting:** UHD 770 uses shared system memory; full offload of large models is typically *slower* than pure CPU because the "GPU" reads and writes through the same memory. Partial offload (`-ngl` 5–20) or small models (<4 GB) benefit most. Flash attention helps Vulkan paths.
- Black Mirror reports `vulkan: likely/available/unknown` from `vulkaninfo` when present, and reads `llama-server --list-devices` output (v1.1.0 capability probe) — device names appear on the engine card when the build exposes them. When no probe exists it says "unknown" rather than guessing.

### llama.cpp SYCL
- Requires: Intel compute runtime / Level Zero (`ze_loader.dll`). Present on many systems via Intel driver packages; if absent, the server fails to find a device **and Black Mirror reports that failure in the log instead of pretending to run**.
- Install the Intel oneAPI Base Toolkit (or standalone compute runtime) to enable it. SYCL targets Intel GPUs including UHD 770 through Level Zero.
- Status on systems without the runtime: engine installs fine; serve attempts fail with a clear startup error. This is intended behavior — unsupported acceleration is never presented as functional.

### Ollama
- Runs as an externally managed service. Black Mirror can *start* `ollama serve` if a binary is configured, and connects to an already-running instance; **it never terminates Ollama processes it did not start** (external processes are listed read-only).
- Models come from Ollama's registry; context length is forwarded as `options.num_ctx` exactly as configured.
- Ollama decides CPU/GPU internally (it supports Intel GPUs via IPEX-LLaMA builds, not the stock installer — stock builds on the reference machine run CPU).

### Lemonade
- AMD's Lemonade Server (embeddable zip is fully portable, lands in Black Mirror's engines folder).
- Optimized for AMD Ryzen AI NPUs and AMD/Intel iGPUs via ONNX Runtime GenAI; also serves GGUF through its llama.cpp backend.
- On the reference Intel machine it runs CPU/GPU paths where supported; NPU features are AMD-only and honestly unavailable.

## Version facts (verified during development)

| Component | Verified release | Note |
|---|---|---|
| llama.cpp | stable pointer release `v1.0.0` → build `b12359`; asset pattern `llama-b{TAG}-bin-win-{cpu,vulkan,sycl}-x64.zip` | resolved via `nightly-tag.txt` stable pointer with fallback chain to newest `b` release; **real binary verified in this environment** (Linux build, b12359: `--help`, `--list-devices`, real streamed inference) |
| Ollama | v0.40.17 | official `OllamaSetup.exe` |
| Lemonade | v2026.47.1 | `lemonade-embeddable-2026.47.1-windows-x64.zip` |

## Known limitations

1. **Multimodal images** are supported through OpenAI-compatible `image_url` parts (Ollama vision models, llama.cpp mmproj-enabled builds if you wire `--mmproj` via extra args). llama.cpp image support is not yet a first-class, tested flow in this app.
2. **GPU telemetry**: per-process Intel iGPU utilization has no standard Windows API Black Mirror can query without vendor SDKs. The Performance view shows `n/a` with an explanation rather than invented numbers. NVIDIA telemetry works when `nvidia-smi` exists.
3. **SYCL device detection** is a runtime check at serve time; absence of `ze_loader.dll` is reported as `unknown`, not `broken`.
4. **Embeddings endpoints** are not surfaced in the UI (engines support them; the chat app does not use them yet).
5. Non-Windows platforms run the app for development; hardware probes (PowerShell, taskkill) degrade gracefully there and features are labeled accordingly.
