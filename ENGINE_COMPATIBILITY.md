# Engine compatibility

Black Mirror installs engines only into its own data directory. It does not upgrade a system Ollama, a system llama.cpp, or a driver.

Asset names below were taken from ggml-org/llama.cpp tag **b12678** (24 Nov 2026) and current Ollama / Lemonade release pages. They are templates, not pinned forever. `{tag}` is the release tag. `{version}` is the tag without a leading `v`.

| Engine id | Linux asset (x64) | Runtime the app looks for | If the runtime is missing |
|---|---|---|---|
| llamacpp-cpu | `llama-{tag}-bin-ubuntu-x64.tar.gz` | none | Available. This is the default. |
| llamacpp-vulkan | `llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz` | `vulkaninfo`, then the binary's `--list-devices` | Experimental. Not described as working. |
| llamacpp-cuda12 | `llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz` (falls back to a 12.4 name if HEAD 404s) | `nvidia-smi` | Experimental. Not installed for you. |
| llamacpp-cuda13 | `llama-{tag}-bin-ubuntu-cuda-13.5-x64.tar.gz` | `nvidia-smi` and a driver new enough for CUDA 13.5 libraries | Experimental. |
| llamacpp-rocm | `llama-{tag}-bin-ubuntu-rocm-10.0-x64.tar.gz` | `rocminfo` listing a GPU | Experimental. amdgpu in sysfs is not ROCm. |
| llamacpp-sycl | `llama-{tag}-bin-ubuntu-sycl-fp32-x64.tar.gz` | `sycl-ls` | Experimental. |
| llamacpp-sycl-fp16 | `llama-{tag}-bin-ubuntu-sycl-fp16-x64.tar.gz` | `sycl-ls` and an Intel GPU that actually accepts FP16 | Experimental. Separate engine so it is not swapped in silently. |
| ollama | `ollama-linux-amd64.tgz` from ollama/ollama | the unpacked `ollama` binary | Isolated. `OLLAMA_MODELS` points at the Black Mirror data dir for processes **this app** starts. |
| lemonade | `lemonade-embeddable-{version}-ubuntu-x64.tar.gz` | the unpacked server | Isolated tarball. |
| lmstudio | none — attach-only | LM Studio's own local server (port 1234 by default); the `lms` CLI is optional | Nothing is installed. Black Mirror connects to a server LM Studio already runs and never starts, stops, loads or unloads anything there. |

arm64 templates exist for CPU, Vulkan, CUDA 13, Ollama and Lemonade where upstream publishes them.

## Legacy NVIDIA (Tesla K80 and other cc 3.x)

Kepler (compute capability 3.5 / 3.7) was removed from CUDA 12. A current CUDA 12 or 13 llama.cpp build will not run a Tesla K80. Black Mirror:

- records compute capability when `nvidia-smi` prints it
- marks CUDA 12/13 **unsupported** for a machine whose only NVIDIA GPUs are below cc 5.0
- does not download an older toolchain automatically
- accepts a custom executable path to a binary you built or saved yourself (CUDA 11 era, or whatever that card's last working release was)

Do not downgrade the OS to chase a wheel. Point the engine at the binary.

## Mixed GPUs

A single llama.cpp process does not combine CUDA and ROCm devices. Tensor split across vendors is reported **unsupported**. Different generations of the same vendor are passed through as `--tensor-split` / `--main-gpu` / `--device` only when you set them and the binary advertises the flags. The app does not decide that every GPU on the PCI bus can participate.

## Custom and older builds

Inference Engines → set custom executable path. The file must be a `llama-server` (or `ollama` / `lemonade-server`) you trust. Capability probing runs `--help` and `--list-devices` and will not send flags the binary does not print.

## Ollama and other people's servers

If `ollama` or `llama-server` is already running, it shows up as external. Black Mirror will not signal it. Use Servers → remote endpoint to chat with an OpenAI-compatible URL you do not own.
