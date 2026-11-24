# Changelog

## Ubuntu edition 1.0.0

Based on upstream Black Mirror **v1.2.2** (https://github.com/kayock/Black-Mirror/releases/tag/v1.2.2). The `package.json` version remains `1.2.2` so it matches that release. This file records the Ubuntu port.

### Added

- Linux hardware probe: CPU model, physical cores, logical threads, instruction flags, RAM, available RAM, swap, sysfs GPUs, nvidia-smi, optional vulkaninfo / rocminfo / sycl-ls.
- Engine descriptors for Ubuntu assets: llama.cpp CPU, Vulkan, CUDA 12, CUDA 13, ROCm, SYCL FP32, SYCL FP16, Ollama tarball, Lemonade embeddable tarball. Windows assets for those families are unchanged.
- Multi-GPU launch fields: main GPU, tensor split, split mode, device string. Emitted only when set, and omitted when the probed binary does not advertise the flag.
- Linux process-group and descendant termination with a confirmed-dead result. Remote endpoints are rejected by name before any signal.
- XDG data directory. Legacy `~/.black-mirror` is reused if it already exists.
- User-level install, uninstall and electron-builder Linux targets (deb, AppImage, tar.gz).
- Native directory and file dialogs in the Electron shell. The web preview still asks for a typed path.
- Regression tests in `tests/linux.test.js`.

### Unchanged on purpose

- Thinking controls from v1.2.2: off sends an explicit disable, it does not only hide text.
- Model files are never moved, copied or deleted by the library.
- Benchmarks and compatibility tests stay manual.
- No accounts, tokens, or telemetry.

### Known limits

- CUDA, Vulkan, ROCm and SYCL inference were **not** executed on a GPU in the packaging environment. See TEST_REPORT.md.
- electron-builder output depends on being able to download Electron and to link against the host's GTK stack.
- Official asset filenames include toolkit versions (`cuda-12.8`, `rocm-10.0`, …). If upstream renames them, install fails cleanly and a custom path still works. The installer tries a short candidate list and recent tags; it does not guess a GPU is supported.

Upstream history: [docs/CHANGELOG.md](docs/CHANGELOG.md).
