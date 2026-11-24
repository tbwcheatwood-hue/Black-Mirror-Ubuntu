# Architecture

Black Mirror keeps one rule: engines change, the studio does not. Each engine is a JSON descriptor plus a small adapter. Chat, the library and the server controller do not contain CUDA or ROCm logic.

Upstream design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This file records the Ubuntu edition layout.

## Process

```
Renderer (vanilla JS, CSP, no framework)
  bridge.js  →  Electron preload  →  main.js IPC
            →  or HttpBridge (?live=1) → main/web/rpc.js
Main process (plain Node, tested without a display)
  core/        config, store, log, conversations
  models/      GGUF parser, library, memory estimate
  engines/     descriptors, adapters, installer, capability probe
  server/      controller, ports, ownership, proctree
  monitor/     samples, winprobe (Windows), linuxprobe (Linux)
  compatlab/   assessor + manual lab
  benchmark/   manual runs only
```

The renderer talks to a running server directly at `http://127.0.0.1:<port>/v1`. The main process does not proxy tokens.

## Platform split

| Concern | Windows | Linux |
|---|---|---|
| Data directory | `%APPDATA%/BlackMirror` | `$XDG_DATA_HOME/black-mirror` (legacy `~/.black-mirror` if that folder already exists) |
| Hardware | PowerShell + nvidia-smi + vulkaninfo | `/proc`, `/sys`, `lscpu`, `nvidia-smi`, `vulkaninfo`, `rocminfo`, `sycl-ls` |
| Extract | Expand-Archive | `unzip` / `tar` |
| Stop a process we own | `taskkill /T /F` | Process-group SIGTERM, then SIGKILL, plus `/proc` descendants |
| Identity | Win32_Process start time | `/proc/<pid>/stat` start ticks |

`main/server/controller.js` is still the only module that spawns or signals inference processes. `killOwnedTree` refuses pid 1 and refuses the app's own pid. A PID is not enough: executable, command line and start time must match the ownership record or the process is classified external and left alone.

## Descriptors

Built-in JSON in `main/engines/builtin/`. User engines go in `<data>/engines.d/*.json` and need no code change if they use an existing family (`llama.cpp`, `ollama`, `lemonade`).

Asset names are chosen from `install.assets["<platform>-<arch>"]`, which may be a string or a list of candidates. The installer HEAD-checks the URL and walks recent tags. It does not pick "whatever is newest" for a GPU the newest build dropped.

## Honesty

- A GPU in sysfs is not a working accelerator.
- `statusCategory: compatible` means a runtime probe answered. It does not mean a model was loaded.
- Compatibility Lab `verified-compatible` requires a saved passing test that included inference.
- Benchmarks are never synthesized.
- Legacy NVIDIA (compute capability below 5.0, including Tesla K80) is **unsupported** on the CUDA 12 and CUDA 13 descriptors. The remedy is a custom executable path to an older binary, not a newer download.
