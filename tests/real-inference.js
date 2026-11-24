'use strict';
/**
 * REAL end-to-end verification: spawns the actual llama.cpp llama-server
 * (Linux build, b12359) through Black Mirror's ServerController, loads a
 * real GGUF model (tinyllamas stories15M Q4_0), and measures real streaming
 * inference. Run: node tests/real-inference.js
 */
const { ServerController } = require('../main/server/controller');
const { Logger } = require('../main/core/log');
const { findFreePort } = require('../main/server/ports');
const { StreamClient } = require('../renderer/js/streamclient');

const LLAMA_SERVER = '/tmp/real-engine/llama-b12359/llama-server';
const MODEL = '/tmp/real-engine/stories15M-q4_0.gguf';

(async () => {
  const fs = require('fs');
  if (!fs.existsSync(LLAMA_SERVER) || !fs.existsSync(MODEL)) {
    console.error('SKIP: real engine or model not present');
    process.exit(2);
  }
  const logger = new Logger('/tmp/bm-real/logs');
  const dir = '/tmp/bm-real';
  const ctl = new ServerController({
    descriptor: () => ({ id: 'llamacpp-cpu-real', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
    adapter: () => ({
      executablePath: () => LLAMA_SERVER,
      buildServerArgs: (modelPath, params, netw) => [
        '-m', modelPath,
        '--host', netw.bind, '--port', String(netw.port),
        '--ctx-size', String(params.contextLength || 512),
        '--threads', String(params.threads || 2),
        '--predict', '64'
      ]
    })
  }, logger, { dataDir: dir, readyTimeoutMs: 60000 });

  const port = await findFreePort(19900, '127.0.0.1');
  console.log('port:', port);
  const t0 = Date.now();
  const server = await ctl.start({ engineId: 'llamacpp-cpu-real', modelPath: MODEL, port, bind: '127.0.0.1', params: { contextLength: 512, threads: 2 } });
  const loadMs = Date.now() - t0;
  console.log('READY (spawn→health 200):', loadMs, 'ms · pid', server.pid, '· status', server.status);

  // capability probe against the REAL binary
  const caps = require('../main/engines/capabilities').probe(LLAMA_SERVER);
  console.log('capability probe:', JSON.stringify({
    probed: caps.probed,
    thinking: caps.helpFlags.thinking,
    jinja: caps.helpFlags.jinja,
    flashAttention: caps.helpFlags.flashAttention,
    cpuMoeLayers: caps.helpFlags.cpuMoeLayers,
    devices: caps.devices.length
  }));

  // model listing
  const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then(r => r.json());
  console.log('/v1/models:', models.data.map(m => m.id).join(', '));

  // real streaming chat
  let firstToken = null, tokens = 0, text = '';
  const t1 = Date.now();
  const result = await StreamClient.chat({
    baseUrl: server.baseUrl, model: 'stories15M',
    messages: [{ role: 'user', content: 'Once upon a time' }],
    params: { maxTokens: 48, temperature: 0.7 },
    signal: null,
    onDelta: d => { if (firstToken === null) firstToken = Date.now() - t1; tokens++; text += d; }
  });
  const elapsed = Date.now() - t1;
  console.log('STREAMED RESPONSE:', JSON.stringify(text.slice(0, 120)));
  console.log('TTFT:', firstToken, 'ms · chunks:', tokens, '· total:', elapsed, 'ms',
    '· usage:', JSON.stringify(result.usage));
  if (result.usage && result.usage.completion_tokens && elapsed > 0) {
    console.log('GENERATION SPEED:', (result.usage.completion_tokens / (elapsed / 1000)).toFixed(1), 'tok/s (wall)');
  }

  // stop through the controller and verify the process tree is gone
  const pid = server.pid;
  await ctl.stop(server.id);
  let alive = true;
  try { process.kill(pid, 0); } catch (_) { alive = false; }
  console.log('STOP: pid', pid, alive ? 'STILL ALIVE (FAIL)' : 'terminated ✓');
  console.log(alive ? 'RESULT: FAIL' : 'RESULT: REAL INFERENCE E2E OK');
  process.exit(alive ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
