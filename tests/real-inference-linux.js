'use strict';
/**
 * Actual CPU inference on Linux when a llama-server binary and a small GGUF
 * are available. Not part of `npm test`. Never fabricates a result.
 *
 *   BLACK_MIRROR_LLAMA_SERVER=/path/to/llama-server \
 *   BLACK_MIRROR_GGUF=/path/to/model.gguf \
 *   node tests/real-inference-linux.js
 */
const fs = require('fs');
const { LlamaCppAdapter } = require('../main/engines/adapters');
const { ServerController } = require('../main/server/controller');
const { Logger } = require('../main/core/log');
const { findFreePort } = require('../main/server/ports');

const exe = process.env.BLACK_MIRROR_LLAMA_SERVER || '/tmp/bm-infer/ext/llama-b12678/llama-server';
const model = process.env.BLACK_MIRROR_GGUF || '/tmp/bm-infer/smollm.gguf';

async function main() {
  if (!fs.existsSync(exe) || !fs.existsSync(model)) {
    console.log(JSON.stringify({ skipped: true, reason: 'binary or GGUF not present', exe, model }));
    process.exit(0);
  }
  const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'bm-real-'));
  const registry = {
    descriptor: () => ({
      id: 'llamacpp-cpu', family: 'llama.cpp', api: 'openai',
      readyProbe: { type: 'http', path: '/health' }, serverBinary: 'llama-server'
    }),
    adapter: () => new LlamaCppAdapter(
      { id: 'llamacpp-cpu', serverBinary: 'llama-server' },
      { customPath: exe }
    )
  };
  const ctl = new ServerController(registry, new Logger(require('path').join(dir, 'logs')), {
    dataDir: dir, readyTimeoutMs: 180000
  });
  const port = await findFreePort(18080);
  const started = Date.now();
  const proc = await ctl.start({
    engineId: 'llamacpp-cpu',
    modelPath: model,
    modelDisplayName: 'smollm2-135m',
    port,
    bind: '127.0.0.1',
    params: { contextLength: 512, threads: 2, gpuLayers: 0, temperature: 0, maxTokens: 16, thinkingMode: 'off' }
  });
  const loadMs = Date.now() - started;
  const body = {
    model: 'local',
    stream: false,
    max_tokens: 16,
    temperature: 0,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }]
  };
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  const stop = await ctl.stop(proc.id);
  const report = {
    skipped: false,
    http: res.status,
    loadMs,
    genMs: Date.now() - t0,
    text: text || null,
    usage: json.usage || null,
    stopConfirmed: stop.confirmed === true,
    portReleased: stop.portReleased,
    gpuTested: false,
    note: 'CPU inference only. CUDA/Vulkan/ROCm/SYCL were not executed.'
  };
  console.log(JSON.stringify(report, null, 2));
  if (!res.ok || !text || stop.confirmed !== true) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
