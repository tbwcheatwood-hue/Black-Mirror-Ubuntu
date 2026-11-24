# Test report — Ubuntu edition 1.0.0

Environment: Linux x86_64, Node.js 22. This machine is a 2-thread Intel Xeon Platinum 8481C with about 4 GB RAM, no swap, and no `nvidia-smi`, `vulkaninfo`, `rocminfo`, or `sycl-ls`. Nothing below invents a GPU result.

Application version under test: upstream **1.2.2**. Distribution label: **Ubuntu edition 1.0.0**.

## Automated unit and integration tests

Command: `node --test --test-timeout=60000 tests/*.test.js` from the project root (the `npm test` script).

| Result | Count |
|---|---:|
| Tests | 155 |
| Suites | 42 |
| Passed | 153 |
| Failed | 0 |
| Skipped | 2 |
| Duration | 19.5 s |

An earlier run, before the Electron binary was downloaded, was 152 passed and 3 skipped (the extra skip was "electron binary not installed"). After the binary was present, one of those checks ran the module-load test and passed. The other discovered that this host has no `libgtk-3.so.0`, so it is skipped instead of reported as a successful launch. The GUI test stays skipped because there is no display.

What the suite actually exercises:

- Server start, readiness, live logs, duplicate prevention, port conflicts, restart, unresolved-stop refusal, remote restart refusal, `stopAll`, crash and readiness-timeout reporting.
- Verified stop: exit observed, port released, HTTP silent. A failed kill is reported unresolved, not as success.
- Ownership: start-time mismatch (PID reuse) is never owned. `killOwnedTree` stops a child and grandchild and does not signal a stranger. Remote endpoints cannot be stopped. External process listing does not kill.
- Linux probe: `/proc` and `/proc/meminfo` parsing, Tesla K80 compute capability marked legacy without invented VRAM, no Vulkan/ROCm/SYCL claim when those tools are not invoked, live probe of this machine.
- Engine descriptors on Linux: CPU, Vulkan, CUDA 12, CUDA 13, ROCm, SYCL, Ollama, Lemonade. Asset resolution selects the Ubuntu CPU tarball. Nested `bin/` binaries are found. XDG data directory.
- llama.cpp version line `version: 1.0.0-dev (build N, commit hex)` and the older `version: 5132 (hex)` form.
- Tensor split and main GPU are passed only when set. Modern CUDA on a K80-only machine is unsupported. Mixed-vendor tensor split is unsupported.
- Thinking controls from v1.2.2: off sends `enable_thinking: false`, `think: false`, and `reasoning_budget: 0`. Auto omits them. An unsupported binary still emits the request-level disable.
- GGUF parse, split shards, mmproj, library import without copy, favorites, profiles, memory estimates, commit-charge warnings.
- Compatibility Lab verdicts: verified only from a fresh passing result that included inference. Staleness when the model mtime or engine tag changes.
- Benchmark pipeline against the mock engine, including time to first token. Not a hardware benchmark.
- Streaming client, conversation search, diagnostics hints.

`tests/real-inference-linux.js` is **not** part of `npm test`. It runs only when a llama-server binary and a GGUF are present.

## Actual Linux CPU inference

Not mocked. Official llama.cpp **b12678** asset `llama-b12678-bin-ubuntu-x64.tar.gz`, binary `llama-b12678/llama-server`, model SmolLM2-135M Q4_K_M (about 100 MB, not shipped in the archive).

The model was asked to reply with the single word "pong". Temperature 0. GPU layers 0. Context 512.

| Field | Value |
|---|---|
| HTTP status | 200 |
| Load time | 558 ms |
| Generation time | 347 ms |
| Text | Pong |
| Prompt tokens | 39 |
| Completion tokens | 3 |
| Stop confirmed | true |
| Port released | true |
| GPU tested | false |

A second run earlier in the same session returned the same text ("Pong") with load 569 ms and generation 353 ms, and the same confirmed stop. Process termination used the Linux process-group path. The server was not left running.

## What was not tested

- CUDA inference. No NVIDIA device and no `nvidia-smi` on this machine.
- Vulkan inference. `vulkaninfo` is not installed. The probe says unknown, not "supported".
- ROCm/HIP inference. `rocminfo` is not installed.
- SYCL inference. `sycl-ls` is not installed.
- Multi-GPU execution. Flag plumbing is unit-tested. No second GPU was present.
- Ollama and Lemonade were not downloaded or started.
- A physical Tesla K80 was not attached. The K80 result is a descriptor assessment against a fixture (compute capability 3.7 → unsupported on the CUDA 12/13 descriptors). That is a code verdict, not a card that was plugged in.
- Electron window on a display. This sandbox has no `DISPLAY`. The GUI launch test skips on purpose.

## Electron runtime

Binary: Electron 45.4.1, downloaded by the package's own install script (not assumed present).

| Check | Result |
|---|---|
| `ELECTRON_RUN_AS_NODE` executes JavaScript | Skipped. Binary is on disk (Electron 45.4.1) but `libgtk-3.so.0` is not installed in this sandbox, so the dynamic linker refused to start it. Not counted as a pass. |
| Main-process modules load | Passed, under Node, for every module the packaged app composes |
| GUI launch | Skipped — no `DISPLAY` |

The `.deb` declares the normal Electron runtime dependencies (`libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1`, `libsecret-1-0`). Those are present on a normal Ubuntu desktop and were not installed into this sandbox (`apt` is not available here). The packages were inspected, not executed.

## Packaged-source retest

The ZIP does not contain `node_modules` or model weights. A clean copy of the source that will be archived (everything except `node_modules` and `dist`) was tested with the same command:

`node --test --test-timeout=60000 tests/*.test.js`

| Result | Count |
|---|---:|
| Tests | 155 |
| Passed | 152 |
| Failed | 0 |
| Skipped | 3 |
| Duration | 18.4 s |

The three skips are the Electron checks. The binary is not in the source archive, so those tests skip instead of pretending the runtime launched. The `.deb`, AppImage and `.tar.gz` live under `dist/` and are inspected in BUILD_LOG.txt. The sealed ZIP was extracted to a clean directory and the same command was repeated: 155 tests, 152 passed, 0 failed, 3 skipped, 17.9 s. It matches the table above.

## Distinction

| Kind | This report |
|---|---|
| Automated unit tests | Yes, full `tests/*.test.js` |
| Mocked integration (mock llama-server) | Yes, controller, benchmark, streaming |
| Actual Linux process execution | Yes, including process-tree kill |
| Actual CPU inference | Yes, llama.cpp b12678 + SmolLM2-135M |
| Actual GPU acceleration | No |
| Packaged application inspection | See BUILD_LOG.txt |
| Hardware still needing a machine with that device | CUDA, Vulkan, ROCm, SYCL, multi-GPU, K80 on metal |
