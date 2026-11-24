# Black Mirror v1.2.2 Verification

Focused corrective release verified on Windows 11 x64 (2026-11-24).

## Automated

- `npm test` — **138/138** passed (includes new `tests/v122.test.js`)
- `npm run dist:verify` — **12/12** passed
- Packaged asar reports **v1.2.2**

## Real inference (Bryce ALS)

Model: `C:\KayockModels\bryce-als\Bryce-ALS-Q4_K_M.gguf`
Engine: managed `llamacpp-cpu` b12359 (`%APPDATA%\BlackMirror\engines\...`)
Script: `tests/real-inference-v122-thinking.js`

| Mode | Reasoning emitted | Content | TTFT | Gen speed |
|---|---|---|---|---|
| **off** | **No** (0 chars) | `4` | 513 ms | 15.50 tok/s |
| **on** | Yes (544 chars) | `2+2 equals 4.` | 576 ms | 7.87 tok/s |
| **auto** | Yes (741 chars; model default) | empty (hit max_tokens while thinking) | 550 ms | 7.96 tok/s |

Off applied both server flags (`--reasoning off`, `--reasoning-budget 0`) and request body (`enable_thinking:false`, `think:false`, `reasoning_budget:0`).

## Preservation

- FOXAI / Z: drive untouched
- Model files read-only
- AppData conversations, config, and CPU/Vulkan/SYCL engines preserved
- Installed app: `C:\BlackMirror\app` → v1.2.2; GUI process started successfully
