# Porting report

## Baseline

Upstream tag **v1.2.2** (`kayock/Black-Mirror`) was copied in full and kept as the source of the Ubuntu edition. The core was already plain Node: GGUF parsing, library, adapters, installer, ownership, compatibility lab, benchmarks and the renderer. Those were not rewritten.

Windows behavior was left in place behind `process.platform === 'win32'` (taskkill, PowerShell probes, Expand-Archive, Win32 paths, existing asset templates).

## What changed

| Area | Change |
|---|---|
| Data dir | XDG Base Directory on Linux, with a fallback to an existing `~/.black-mirror` |
| Hardware | New `main/monitor/linuxprobe.js`. Registry `hardwareInfo()` uses it on Linux and the previous probes on Windows |
| Engines | Linux asset map on existing descriptors. New ids: `llamacpp-cuda12`, `llamacpp-cuda13`, `llamacpp-rocm`, `llamacpp-sycl-fp16`. Ollama on Linux is an isolated tarball, not `install.sh` |
| Installer | Platform asset selection, `{version}` substitution, candidate list, binary search under `bin/` and `build/bin/`, chmod +x after staging |
| Multi-GPU | Optional `--main-gpu`, `--tensor-split`, `--split-mode`, `--device`, gated by `--help` when the binary was probed |
| Processes | Detached process group on Linux. `main/server/proctree.js` signals only that group and its descendants. Stop stays unconfirmed until the PIDs are gone, the port is released, and the HTTP probe is silent |
| Remotes | `stop()` rejects ids in the remote registry before it looks for a PID |
| UI | Ubuntu subtitle, Linux path hints, GTK dialogs when running under Electron, XDG folder button |
| Packaging | `scripts/install-ubuntu.sh`, `scripts/uninstall-ubuntu.sh`, `scripts/build-linux.sh`, deb / AppImage / tar.gz targets |
| Preview | `main/web/rpc.js` exposes the same operations over HTTP so a browser can drive the real backend. This is not a second product |

## What was not claimed

GPU inference. The packaging environment's probe results are in TEST_REPORT.md. "Compatible" in the engine list means a runtime tool answered, or (for CPU) that no runtime is required. It does not mean a lab test passed.

## Attribution

Original work: Black Mirror Project, MIT, https://github.com/kayock/Black-Mirror

This edition does not replace that copyright. Third-party engines keep their own licenses and are not bundled.
