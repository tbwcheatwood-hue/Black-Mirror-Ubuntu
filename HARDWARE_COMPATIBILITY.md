# Hardware compatibility

Detection uses what the machine actually exposes. Missing tools stay "unknown". A row in this table is not a promise that inference was benchmarked on that hardware.

| Check | Source | What "present" means | What it does not mean |
|---|---|---|---|
| CPU model, threads | `/proc/cpuinfo`, `lscpu` if installed | The strings and counts the kernel reported | A recommended thread count is optimal |
| Physical cores | `physical id` + `core id`, else `lscpu -p` | Unique core ids | Always available on tiny VMs that omit those fields |
| ISA flags | `flags` line | avx, avx2, avx512f, fma, sse4, neon/asimd when listed | The engine was built with those flags |
| RAM / available / swap | `/proc/meminfo` | Byte counts from the kernel | The model will fit |
| NVIDIA | `nvidia-smi` query | Name, VRAM, driver, compute capability, CUDA version line | The selected llama.cpp build can use that GPU |
| AMD / Intel cards | `/sys/class/drm/card*/device` vendor id | Vendor, device id, driver name, VRAM when `mem_info_vram_total` exists | Vulkan, ROCm or SYCL works |
| Vulkan | `vulkaninfo --summary` | The tool ran and printed a device | A model will offload |
| ROCm | `rocminfo` | The tool ran and printed a GPU agent | HIP kernels for this model exist |
| SYCL | `sycl-ls` | The tool printed a level-zero/opencl/cuda/hip device | This GGUF architecture is supported |
| CUDA runtime | `nvidia-smi` success | The driver answered | libcudart from a CUDA 13 build will load |

Intel integrated graphics usually have no dedicated VRAM figure. They are reported as shared memory. Offload moves compute onto the same RAM; it does not add capacity. The pre-load assessment says this when the accelerator is a GPU.

## Multi-GPU

Every card the probe could name is listed. Telemetry numbers are filled only for devices `nvidia-smi` actually returned. Other cards stay without utilization. The UI shows `n/a` rather than a made-up percent.

Unsupported combinations called out in the compatibility lab:

- Modern CUDA engine + compute capability below 5.0 (Kepler, Tesla K80)
- Tensor split while both NVIDIA and AMD (or another pair of vendors) are present

## What this app will not do

- Install or remove a driver, kernel module, CUDA deb, or ROCm package
- Claim acceleration because a PCI device exists
- Change Wi-Fi, Bluetooth, or boot settings
- Start itself at login unless you add that yourself

## Targets

Ubuntu 22.04 LTS and 24.04 LTS are the intended hosts. Newer Ubuntu releases work when their glibc can run the engine build you install. CPU inference has the widest net. GPU builds follow the glibc and driver baseline of the upstream tarball, which is not something Black Mirror can relax.
