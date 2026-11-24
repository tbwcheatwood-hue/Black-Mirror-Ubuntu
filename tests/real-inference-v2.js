'use strict';
/**
 * EXPANDED real-inference verification (v1.2.0).
 *
 * Real engines, real models, real processes — Linux CPU sandbox:
 *   - Model A: stories15M-q4_0 (llama arch, Q4_0 quant, 19 MB)
 *   - Model B: qwen2.5-0.5b-instruct-q8_0 (qwen2 arch, Q8_0 quant, ~640 MB)
 *   - multiple context configurations (512 / 1024)
 *   - streaming with TTFT, cancellation mid-stream
 *   - repeated load→unload cycles, verified stop, restart, model switching
 *   - thinking-mode request shaping (request-level evidence)
 *
 * NOT performed here (documented honestly in TEST_REPORT):
 *   - MoE real inference (no small-enough public MoE GGUF; estimates covered by unit tests)
 *   - Windows execution (different hardware/OS entirely)
 *
 * Run: node tests/real-inference-v2.js
 */
const { ServerController } = require('../main/server/controller');
const { Logger } = require('../main/core/log');
const { findFreePort } = require('../main/server/ports');
const fs = require('fs');

const LLAMA_SERVER = '/tmp/real-engine/llama-b12359/llama-server';
const MODEL_A = '/tmp/real-engine/stories15M-q4_0.gguf';
const MODEL_B = '/tmp/real-engine/qwen25-05b-q8_0.gguf';

const results = [];
function log(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✕'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function startServer(ctl, modelPath, port, ctx) {
  return ctl.start({
    engineId: 'llamacpp-cpu-real', modelPath, port, bind: '127.0.0.1',
    params: { contextLength: ctx, threads: 2 }
  });
}

async function streamOnce(baseUrl, prompt, maxTokens, onDelta, abortAfterMs) {
  const ac = new AbortController();
  const timer = abortAfterMs ? setTimeout(() => ac.abort(new Error('cancellation-test')), abortAfterMs) : null;
  const t0 = Date.now();
  let ttft = null, chunks = 0, text = '';
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      signal: ac.signal
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      if (ttft === null && value && value.length) ttft = Date.now() - t0;
      const s = dec.decode(value, { stream: true });
      if (onDelta) onDelta(s); else text += s;
    }
    clearTimeout(timer);
    return { ttft, chunks, text, elapsed: Date.now() - t0, cancelled: false };
  } catch (e) {
    clearTimeout(timer);
    return { cancelled: e.name === 'AbortError' || /cancellation-test/.test(String(e.cause || e.message || e)), chunks, ttft, error: e.message };
  }
}

(async () => {
  const missing = [LLAMA_SERVER, MODEL_A, MODEL_B].filter(p => !fs.existsSync(p));
  if (missing.length) { console.error('SKIP, missing:', missing); process.exit(2); }

  const dir = '/tmp/bm-real-v2';
  fs.rmSync(dir, { recursive: true, force: true });
  const logger = new Logger(`${dir}/logs`);
  const ctl = new ServerController({
    descriptor: () => ({ id: 'llamacpp-cpu-real', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
    adapter: () => ({
      executablePath: () => LLAMA_SERVER,
      buildServerArgs: (modelPath, params, netw) => [
        '-m', modelPath, '--host', netw.bind, '--port', String(netw.port),
        '--ctx-size', String(params.contextLength || 512), '--threads', String(params.threads || 2), '--predict', '48'
      ]
    })
  }, logger, { dataDir: dir, readyTimeoutMs: 120000 });

  // ---- 1. two architectures, two quantizations, multiple contexts ----
  const portA = await findFreePort(19950, '127.0.0.1');
  let s = await startServer(ctl, MODEL_A, portA, 512);
  log('load: llama arch / Q4_0 / ctx 512', s.status === 'running', `pid ${s.pid}`);
  const r1 = await streamOnce(s.baseUrl, 'Once upon a time', 40);
  log('streamed inference: stories15M', r1.text && r1.text.length > 5, `TTFT ${r1.ttft} ms, ${r1.chunks} chunks`);
  const r2 = await streamOnce(s.baseUrl, 'The little robot', 40, null, 30);
  log('cancellation mid-stream', r2.cancelled === true, `aborted after ~30 ms with ${r2.chunks} chunks received`);

  // restart with a different context (config preserved, same model)
  let st = await ctl.restart(s.id);
  log('restart keeps configuration', st.status === 'running' && st.port === portA, `pid ${st.pid} (new) port ${st.port}`);
  const r2b = await streamOnce(st.baseUrl, 'Once', 16, null, 30000);
  log('inference after restart @ ctx 512', !r2b.cancelled && r2b.text.length > 0, `TTFT ${r2b.ttft} ms`);

  // ---- 2. model switching (A -> B), second architecture + quant ----
  const stopA = await ctl.stop(st.id);
  log('stop model A confirmed', stopA.confirmed === true, `port released=${stopA.portReleased} httpDown=${stopA.httpDown}`);
  const portB = await findFreePort(19960, '127.0.0.1');
  const sb = await startServer(ctl, MODEL_B, portB, 1024);
  log('load: qwen2 arch / Q8_0 / ctx 1024 (model switch)', sb.status === 'running', `pid ${sb.pid}`);
  const r3 = await streamOnce(sb.baseUrl, 'What is 2+2? Answer with the number only.', 12);
  log('streamed inference: qwen2.5-0.5b', r3.text && r3.text.length > 0, `TTFT ${r3.ttft} ms, ${r3.chunks} chunks`);
  const r3b = await streamOnce(sb.baseUrl, 'Count: one two', 16, null, 30);
  log('cancellation: qwen2.5-0.5b', r3b.cancelled === true, `aborted, ${r3b.chunks} chunks`);

  // ---- 3. repeated load/unload cycles ----
  let cyclesOk = true;
  let current = sb;
  for (let i = 0; i < 3; i++) {
    const stop = await ctl.stop(current.id);
    const again = await startServer(ctl, MODEL_B, portB + i + 1, 1024);
    const ok = stop.confirmed && again.status === 'running';
    if (!ok) cyclesOk = false;
    console.log(`   cycle ${i + 1}: stop confirmed=${stop.confirmed}, reload pid=${again.pid}`);
    current = again;
  }
  await ctl.stop(current.id);
  log('3x load→unload cycle (B) with verified stops', cyclesOk);

  // ---- 4. thinking-mode request shaping (evidence level: request construction) ----
  const { LlamaCppAdapter } = require('../main/engines/adapters');
  const adapter = new LlamaCppAdapter({ id: 'x', family: 'llama.cpp' }, {});
  const off = adapter.buildRequestOverrides({ thinkingMode: 'off' });
  const on = adapter.buildRequestOverrides({ thinkingMode: 'on' });
  log('thinking request shapes',
    off.chat_template_kwargs?.enable_thinking === false
      && off.reasoning_budget === 0
      && off.think === false
      && on.chat_template_kwargs?.enable_thinking === true
      && on.think === true,
    `off → ${JSON.stringify({ kwargs: off.chat_template_kwargs, budget: off.reasoning_budget, think: off.think })}; on → ${JSON.stringify({ kwargs: on.chat_template_kwargs, think: on.think })}`);

  // ---- 5. ownership records persisted for restart recovery ----
  const storeFile = `${dir}/managed-processes.json`;
  const stopped = !fs.existsSync(storeFile) || JSON.parse(fs.readFileSync(storeFile, 'utf8')).records.length === 0;
  log('ownership records cleaned after verified stops', stopped, storeFile);

  const failed = results.filter(r => !r.ok);
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} real-inference checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
