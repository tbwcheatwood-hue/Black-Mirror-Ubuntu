# Black Mirror — Ubuntu Edition 1.0.0

**Your Machine. Your Models. Your Intelligence.**

This is the Ubuntu edition of [Black Mirror](https://github.com/kayock/Black-Mirror) **v1.2.2** (MIT, Black Mirror Project). The application version inside the package stays **1.2.2** so it matches the upstream release this port is built on. The distribution itself is **Ubuntu edition 1.0.0**.

It is a local LLM studio: model library, inference-engine manager, server controller, compatibility lab and benchmark lab. Chat traffic stays on your machine unless you deliberately bind the API to your LAN. There are no accounts and no cloud requirement.

The original Windows paths still work. Linux uses the same core modules with native hardware probes, process groups and engine descriptors.

## What you can do

| Area | Behavior |
|---|---|
| Chat | Streaming, stop, regenerate, edit and resend, markdown, syntax highlighting, thinking auto/on/off, separate reasoning, attachments, token stats |
| Library | Recursive GGUF scan, import without copy, split shards, mmproj pairing, favorites, per-model profiles, memory estimates |
| Engines | llama.cpp CPU, Vulkan, CUDA 12, CUDA 13, ROCm, SYCL FP32, SYCL FP16, Ollama, Lemonade. Multiple versions, rollback, custom binaries |
| Servers | Start, stop, restart, verified termination, port conflicts, connect-only remote endpoints |
| Compat Lab | Manual tests. Verdicts stay verified / likely / experimental / unsupported. Nothing is marked verified without a saved pass |
| Benchmarks | Manual only. Numbers come from real requests |

## Requirements

- Ubuntu 22.04 LTS, 24.04 LTS, or a newer Ubuntu that can run the engine binary you choose
- x64 or arm64
- Node.js 18+ only if you run from source. A packaged build carries its own runtime
- No dedicated GPU required. CPU llama.cpp is the safe default
- No Docker, and no root, for normal use or for installing engines into Black Mirror's data folder

Black Mirror does **not** install graphics drivers, CUDA, ROCm, kernels, or another application's copy of Ollama.

## Install

**From a packaged build** (after `scripts/build-linux.sh`):

```bash
sudo dpkg -i dist/black-mirror_*_amd64.deb    # optional; the .deb may pull Electron's usual libraries
# or, with no root:
./scripts/install-ubuntu.sh
```

**From source:**

```bash
cd black-mirror
npm ci --no-audit --no-fund
npm test
npm start
```

`scripts/install-ubuntu.sh` writes a desktop file and a launcher in `~/.local/bin`. It does not enable autostart.

**Uninstall:** `scripts/uninstall-ubuntu.sh`. Add `--purge` to delete settings and engines under `$XDG_DATA_HOME/black-mirror`. Model files are never deleted.

## First run

1. Inference Engines → install **llama.cpp (CPU)** unless you have already probed a GPU runtime.
2. Model Library → add a directory. Files stay where they are.
3. Servers → launch, read the memory assessment, then chat.
4. Other apps can use `http://127.0.0.1:8081/v1` (the port you chose). Binding `0.0.0.0` exposes the API on your LAN with no authentication. The UI says so.

User data lives in `$XDG_DATA_HOME/black-mirror` (usually `~/.local/share/black-mirror`). An older `~/.black-mirror` directory is kept if it already exists and the XDG directory does not.

## Engines

Official assets are downloaded from GitHub on your request and extracted only under the data directory. See [ENGINE_COMPATIBILITY.md](ENGINE_COMPATIBILITY.md). A custom executable path is how you register an older CUDA 11 build for Kepler cards such as Tesla K80. Current CUDA 12/13 assets do not support those GPUs, and this app will not pretend they do.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [BUILD.md](BUILD.md)
- [ENGINE_COMPATIBILITY.md](ENGINE_COMPATIBILITY.md)
- [HARDWARE_COMPATIBILITY.md](HARDWARE_COMPATIBILITY.md)
- [TEST_REPORT.md](TEST_REPORT.md)
- [PORTING_REPORT.md](PORTING_REPORT.md)
- [CHANGELOG.md](CHANGELOG.md)
- Upstream notes remain in [docs/](docs/)

## License

MIT. Copyright (c) 2026 Black Mirror Project. See [LICENSE](LICENSE).

Upstream: https://github.com/kayock/Black-Mirror

**BLACK MIRROR** — *Your Machine. Your Models. Your Intelligence.*

*The intelligence changes. The mirror remains.*
