'use strict';
/**
 * Real-inference verification for v1.2.2 thinking control on Bryce ALS.
 * Starts a temporary llama-server on a free port; does not touch managed
 * Black Mirror servers or FOXAI/Z: paths.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { StreamClient } = require('../renderer/js/streamclient');
const { LlamaCppAdapter } = require('../main/engines/adapters');
const capabilities = require('../main/engines/capabilities');

const MODEL = 'C:\\KayockModels\\bryce-als\\Bryce-ALS-Q4_K_M.gguf';
const EXE = path.join(process.env.APPDATA, 'BlackMirror', 'engines', 'llamacpp-cpu', 'b12359', 'llama-server.exe');
const PROMPT = 'Reply with exactly one short sentence: what is 2+2?';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function waitReady(baseUrl, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/health');
      if (r.ok) return true;
    } catch (_) { /* loading */ }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error('server not ready');
}

async function runMode(mode, port) {
  const caps = capabilities.probe(EXE);
  const adapter = new LlamaCppAdapter(
    { id: 'llamacpp-cpu', family: 'llama.cpp', serverBinary: 'llama-server' },
    {},
    caps
  );
  const params = {
    contextLength: 4096,
    threads: 6,
    gpuLayers: 0,
    maxTokens: 256,
    temperature: 0.2,
    thinkingMode: mode
  };
  const args = adapter.buildServerArgs(MODEL, params, { port, bind: '127.0.0.1' });
  const overrides = adapter.buildRequestOverrides(params);
  console.log(`\n=== thinkingMode=${mode} ===`);
  console.log('server args (thinking-related):', args.filter((a, i, arr) =>
    /reasoning|jinja|think/i.test(a) || /reasoning|jinja|think/i.test(arr[i - 1] || '')
  ).join(' '));
  console.log('request overrides:', JSON.stringify(overrides));

  const logFile = path.join(os.tmpdir(), `bm-v122-${mode}.log`);
  const out = fs.openSync(logFile, 'w');
  const child = spawn(EXE, args, { stdio: ['ignore', out, out], windowsHide: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitReady(baseUrl);
    const models = await (await fetch(baseUrl + '/v1/models')).json();
    console.log('GET /v1/models:', JSON.stringify(models?.data?.[0]?.id || models));

    const bodyPreview = {
      model: 'Bryce-ALS-Q4_K_M',
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
      stream_options: { include_usage: true },
      ...overrides
    };
    console.log('HTTP body keys:', Object.keys(bodyPreview).join(', '));

    const result = await StreamClient.chat({
      baseUrl,
      model: 'Bryce-ALS-Q4_K_M',
      messages: [{ role: 'user', content: PROMPT }],
      params,
      thinking: mode,
      engineFamily: 'llama.cpp'
    });
    const hasReasoning = !!(result.reasoning && result.reasoning.trim());
    console.log('content:', JSON.stringify((result.content || '').slice(0, 200)));
    console.log('reasoning length:', hasReasoning ? result.reasoning.length : 0);
    console.log('reasoning preview:', hasReasoning ? JSON.stringify(result.reasoning.slice(0, 160)) : '(none)');
    console.log('usage:', JSON.stringify(result.usage));
    console.log('ttftMs:', result.firstTokenMs, 'elapsedMs:', result.elapsedMs, 'tps:', result.tps != null ? result.tps.toFixed(2) : 'n/a');
    return {
      mode,
      hasReasoning,
      reasoningChars: hasReasoning ? result.reasoning.length : 0,
      contentChars: (result.content || '').length,
      usage: result.usage,
      ttftMs: result.firstTokenMs,
      elapsedMs: result.elapsedMs,
      tps: result.tps,
      serverArgs: args,
      overrides,
      modelId: models?.data?.[0]?.id || null
    };
  } finally {
    try { child.kill(); } catch (_) { /* */ }
    await new Promise(r => setTimeout(r, 500));
    try { fs.closeSync(out); } catch (_) { /* */ }
  }
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('llama-server missing: ' + EXE);
  if (!fs.existsSync(MODEL)) throw new Error('model missing: ' + MODEL);
  console.log('EXE', EXE);
  console.log('MODEL', MODEL);
  const caps = capabilities.probe(EXE);
  console.log('probed flags:', {
    thinking: !!caps.helpFlags.thinking,
    reasoningSwitch: !!caps.helpFlags.reasoningSwitch,
    reasoningBudget: !!caps.helpFlags.reasoningBudget,
    jinja: !!caps.helpFlags.jinja
  });

  const results = {};
  for (const mode of ['off', 'on', 'auto']) {
    const port = await freePort();
    results[mode] = await runMode(mode, port);
  }

  console.log('\n=== SUMMARY ===');
  for (const mode of ['off', 'on', 'auto']) {
    const r = results[mode];
    console.log(`${mode}: reasoning=${r.hasReasoning} (${r.reasoningChars} chars) content=${r.contentChars} tps=${r.tps != null ? r.tps.toFixed(2) : 'n/a'} ttft=${r.ttftMs}ms`);
  }
  const offOk = results.off && !results.off.hasReasoning;
  const onHas = results.on && results.on.hasReasoning;
  console.log('\nVERDICT thinking-off prevented reasoning:', offOk ? 'YES' : 'NO (model/template may ignore disable)');
  console.log('VERDICT thinking-on produced reasoning:', onHas ? 'YES' : 'NO (model may not think by default)');
  const outPath = path.join(os.tmpdir(), 'bm-v122-thinking-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('wrote', outPath);
  process.exit(0);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
