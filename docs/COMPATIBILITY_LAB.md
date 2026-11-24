# COMPATIBILITY_LAB.md

The Compatibility Lab answers one question: **will this model, on this engine, on this hardware, with this launch configuration actually work?** It uses conventional software inspection, capability probing and manually initiated real tests. It does not use another AI model, and nothing runs automatically.

## What it inspects

### Model inspection (confirmed metadata)

Everything in the model panel comes from real GGUF parsing (`main/models/gguf.js`) and is labeled:

| Field | Source | Label |
|---|---|---|
| Architecture | `general.architecture` key | CONFIRMED |
| Quantization | file type / name metadata | CONFIRMED |
| Parameter count | `general.size_label` | CONFIRMED (or ESTIMATED from size when absent) |
| Dense / MoE | expert tensor keys | CONFIRMED |
| Expert counts | `expert_count` / `expert_used` | CONFIRMED |
| Model size | file size(s) | CONFIRMED |
| Split status | shard grouping (`-00001-of-00003` pattern) | CONFIRMED (incl. missing shards) |
| Native context | `llama.context_length_train` and equivalents | CONFIRMED |
| Multimodal | mmproj-kind detection + vision tensors | CONFIRMED where present |
| Memory requirements | `estimate.js` model | **ESTIMATE** (weights ±2 %, KV ±5 %, compute allowance ±30 %) |

### Engine inspection (probed, not assumed)

Everything in the engine panel comes from probing the *installed binary* (`main/engines/capabilities.js`):

- installed version (CLI version probe), latest release discovered via the 4-strategy release chain ("Check for newer release")
- executable path (custom overrides shown, missing overrides flagged MISSING)
- supported launch arguments (`--help` probe)
- detected compute devices (`--list-devices`)
- KV cache formats, flash attention, CPU MoE offload, multimodal projector support
- known limitations (status reason / probe notes)

A flag's existence is treated as **necessary, not sufficient**: `--mmproj` being advertised does not prove a specific vision architecture works — that is what the staged test is for.

## Compatibility assessment

Select a model, engine, acceleration method and launch parameters, then press **Assess**. The verdict is one of:

| Status | Meaning |
|---|---|
| `verified-compatible` | a staged test PASSED for exactly this configuration and its inputs (model file, engine version, app version) have not changed since |
| `likely-compatible` | static analysis found no blockers on this machine |
| `experimental` | plausible but unverified acceleration (e.g. Vulkan present but never tested with this model) |
| `insufficient-information` | engine missing/not probeable — cannot honestly evaluate |
| `unsupported` | concrete contradiction: invalid GGUF, missing shards, memory need exceeding free RAM, KV format not advertised by the binary |
| `previously-failed` | a staged test FAILED for exactly this configuration (failed stages listed) |

Every verdict ships with **reasons** and a **checks** table (model, capabilities, acceleration, memory) so the "why" is always visible. The assessor lives in `main/compatlab/assessor.js` and is covered by unit tests including staleness rules.

## Staged manual tests

**Run staged compatibility test** executes the ladder below. Each stage runs only if the previous passed; a failure records its diagnostics and stops the ladder. Loading a model here uses a *reduced* context (max 2048) and a dedicated port to keep the test cheap.

1. `exe-startup` — the engine binary starts with the given configuration
2. `device-detect` — what devices the binary itself reports
3. `load` — the model actually loads and the server becomes ready (measured)
4. `inference` — one short completion returns text (measured)
5. `streaming` — a streamed completion arrives in >1 chunk (TTFT measured)
6. `thinking` — the adapter constructs explicit on/off thinking requests (never merely omits the parameter)
7. `terminate` — the server stops and termination is **verified** (exit observed, port released, endpoint silent)

## Saved results and staleness

Every run is saved to `compat-results.json` in the data directory with the configuration key (model path + mtime, engine id + version tag, acceleration, profile), the full per-stage report and the measurements. Results are shown in the table with a freshness badge:

- **current** — model file unchanged, engine version unchanged, app version unchanged
- **stale** — a listed input changed (the reason is shown, e.g. "engine version changed (b12359 → b12400)"). Stale results are never used as `verified-compatible` evidence; the assessor reverts to static analysis or asks for a re-run.

**Export results** writes the complete result history to a JSON file chosen by the browser download flow — locally, nothing is transmitted.

## IPC surface

| Channel | Purpose |
|---|---|
| `lab:assess` | static assessment for a model+engine+acceleration+params |
| `lab:runTest` | run the staged test (manual only) |
| `lab:results` | saved results incl. staleness |
| `lab:invalidate` | mark results stale (e.g. after engine uninstall) |
| `lab-progress` | per-stage progress events |
| `engines:checkUpdate` | release-discovery update check |
| `profiles:list` | recommended launch profiles |
| `diag:snapshot` / `diag:export` | diagnostics snapshot / local export |

## Boundary with the Benchmark Lab

Compatibility Lab answers **whether it works**. Benchmark Lab answers **how well a working configuration performs**. A compatibility test loads a small context for a few seconds and is not a performance measurement; benchmark numbers come only from the Benchmark Lab, always manually started.
