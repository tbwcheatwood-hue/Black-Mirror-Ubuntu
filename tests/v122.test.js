'use strict';
/**
 * Black Mirror v1.2.2 regression suite:
 * thinking mode request/server args, server public identity, conversation
 * model persistence, streaming usage/telemetry formatting.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { LlamaCppAdapter } = require('../main/engines/adapters');
const capabilities = require('../main/engines/capabilities');
const { Conversations } = require('../main/core/conversations');
const { StreamClient, normalizeUsage } = require('../renderer/js/streamclient');

const DESC = { id: 'llamacpp-cpu', family: 'llama.cpp', serverBinary: 'llama-server' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-v122-'));
}

function sseServer(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function chunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

describe('v1.2.2 thinking mode — request payload construction', () => {
  test('thinkingMode off sends enable_thinking:false, think:false, reasoning_budget:0', () => {
    const a = new LlamaCppAdapter(DESC, {});
    const ov = a.buildRequestOverrides({ thinkingMode: 'off', temperature: 0.7 });
    assert.deepEqual(ov.chat_template_kwargs, { enable_thinking: false });
    assert.equal(ov.think, false);
    assert.equal(ov.reasoning_budget, 0);
    assert.equal(ov.temperature, 0.7);
  });

  test('thinkingMode on sends enable_thinking:true and think:true', () => {
    const a = new LlamaCppAdapter(DESC, {});
    const ov = a.buildRequestOverrides({ thinkingMode: 'on' });
    assert.deepEqual(ov.chat_template_kwargs, { enable_thinking: true });
    assert.equal(ov.think, true);
    assert.equal('reasoning_budget' in ov, false);
  });

  test('thinkingMode auto leaves thinking controls untouched', () => {
    const a = new LlamaCppAdapter(DESC, {});
    const ov = a.buildRequestOverrides({ thinkingMode: 'auto', maxTokens: 128 });
    assert.equal('chat_template_kwargs' in ov, false);
    assert.equal('think' in ov, false);
    assert.equal('reasoning_budget' in ov, false);
    assert.equal(ov.max_tokens, 128);
  });

  test('server args: off emits --reasoning off and --reasoning-budget 0 when supported', () => {
    const caps = {
      probed: true,
      helpFlags: {
        thinking: true, reasoningSwitch: true, reasoningBudget: true, jinja: true,
        kvCacheK: true, kvCacheV: true, flashAttention: true, parallelSlots: true
      }
    };
    const a = new LlamaCppAdapter(DESC, {}, caps);
    const args = a.buildServerArgs('/m/x.gguf', { contextLength: 4096, thinkingMode: 'off' }, { port: 9, bind: '127.0.0.1' });
    const reaIdx = args.indexOf('--reasoning');
    assert.ok(reaIdx >= 0, 'expected --reasoning');
    assert.equal(args[reaIdx + 1], 'off');
    const budIdx = args.indexOf('--reasoning-budget');
    assert.ok(budIdx >= 0, 'expected --reasoning-budget');
    assert.equal(args[budIdx + 1], '0');
    assert.ok(args.includes('--jinja'));
  });

  test('server args: on emits --reasoning-format and --reasoning on when supported', () => {
    const caps = {
      probed: true,
      helpFlags: {
        thinking: true, reasoningSwitch: true, reasoningBudget: true, jinja: true
      }
    };
    const a = new LlamaCppAdapter(DESC, {}, caps);
    const args = a.buildServerArgs('/m/x.gguf', { contextLength: 4096, thinkingMode: 'on' }, { port: 9, bind: '127.0.0.1' });
    assert.ok(args.includes('--reasoning-format'));
    const reaIdx = args.indexOf('--reasoning');
    assert.ok(reaIdx >= 0);
    assert.equal(args[reaIdx + 1], 'on');
    assert.ok(!args.includes('--reasoning-budget'));
  });

  test('server args: auto omits explicit reasoning switch/budget', () => {
    const caps = {
      probed: true,
      helpFlags: { thinking: true, reasoningSwitch: true, reasoningBudget: true, jinja: true }
    };
    const a = new LlamaCppAdapter(DESC, {}, caps);
    const args = a.buildServerArgs('/m/x.gguf', { contextLength: 4096, thinkingMode: 'auto' }, { port: 9, bind: '127.0.0.1' });
    assert.ok(!args.includes('--reasoning'));
    assert.ok(!args.includes('--reasoning-budget'));
    assert.ok(!args.includes('--reasoning-format'));
  });

  test('unsupported thinking binary still emits request-level disable', () => {
    const caps = {
      probed: true,
      helpFlags: { thinking: false, reasoningSwitch: false, reasoningBudget: false, jinja: true }
    };
    const a = new LlamaCppAdapter(DESC, {}, caps);
    const args = a.buildServerArgs('/m/x.gguf', { contextLength: 4096, thinkingMode: 'off' }, { port: 1, bind: '127.0.0.1' });
    assert.ok(!args.includes('--reasoning'));
    assert.ok(!args.includes('--reasoning-budget'));
    const ov = a.buildRequestOverrides({ thinkingMode: 'off' });
    assert.deepEqual(ov.chat_template_kwargs, { enable_thinking: false });
    assert.equal(ov.reasoning_budget, 0);
  });
});

describe('v1.2.2 StreamClient thinking + usage payload', () => {
  test('off puts enable_thinking:false and reasoning_budget:0 in HTTP body', async () => {
    let body = null;
    const { srv, port } = await sseServer((req, res) => {
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        body = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        chunk(res, { choices: [{ delta: { content: 'ok' } }] });
        chunk(res, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await StreamClient.chat({
      baseUrl: `http://127.0.0.1:${port}`,
      messages: [{ role: 'user', content: 'hi' }],
      params: { thinkingMode: 'off', temperature: 0.5 },
      thinking: 'off',
      engineFamily: 'llama.cpp'
    });
    assert.equal(body.think, false);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_budget, 0);
    assert.equal(body.temperature, 0.5);
    assert.deepEqual(body.stream_options, { include_usage: true });
    srv.close();
    await new Promise(r => srv.on('close', r));
  });

  test('on puts enable_thinking:true; auto omits thinking keys', async () => {
    const bodies = [];
    for (const mode of ['on', 'auto']) {
      const { srv, port } = await sseServer((req, res) => {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          chunk(res, { choices: [{ delta: { content: 'x' } }] });
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      await StreamClient.chat({
        baseUrl: `http://127.0.0.1:${port}`,
        messages: [],
        thinking: mode,
        engineFamily: 'llama.cpp'
      });
      srv.close();
      await new Promise(r => srv.on('close', r));
    }
    assert.equal(bodies[0].think, true);
    assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: true });
    assert.equal('think' in bodies[1], false);
    assert.equal('chat_template_kwargs' in bodies[1], false);
    assert.equal('reasoning_budget' in bodies[1], false);
  });

  test('missing usage fields stay null (not fabricated zeros); cancel keeps partial content', async () => {
    const { srv, port } = await sseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { choices: [{ delta: { content: 'hi' } }] });
      // no usage chunk
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const result = await StreamClient.chat({ baseUrl: `http://127.0.0.1:${port}`, messages: [] });
    assert.equal(result.usage, null);
    assert.equal(result.tps, null);
    assert.equal(result.content, 'hi');
    srv.close();
    await new Promise(r => srv.on('close', r));

    const { srv: srv2, port: port2 } = await sseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { choices: [{ delta: { content: 'partial' } }] });
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const stopped = await StreamClient.chat({
      baseUrl: `http://127.0.0.1:${port2}`, messages: [], signal: ac.signal
    });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.content, 'partial');
    assert.equal(stopped.usage, null);
    srv2.close();
    await new Promise(r => srv2.on('close', r));
  });

  test('normalizeUsage never invents zeros for missing fields', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage({}), null);
    assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: null }), {
      prompt_tokens: 10, completion_tokens: null, reasoning_tokens: null, total_tokens: null
    });
    assert.deepEqual(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 3, total_tokens: 6 }), {
      prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 3, total_tokens: 6
    });
  });
});

describe('v1.2.2 server identity (_public)', () => {
  test('controller _public exposes displayName and params (never undefined name)', () => {
    const { ServerController } = require('../main/server/controller');
    const ctl = new ServerController(
      { getAdapter: () => null, get: () => null },
      { info() {}, warn() {}, error() {}, debug() {} },
      { dataDir: tmpDir() }
    );
    const pub = ctl._public({
      id: 'p1', pid: 1, engineId: 'llamacpp-cpu',
      model: 'C:\\KayockModels\\bryce-als\\Bryce-ALS-Q4_K_M.gguf',
      displayName: null,
      params: { thinkingMode: 'off', contextLength: 8192 },
      port: 8081, bind: '127.0.0.1', startedAt: Date.now(),
      status: 'running', family: 'llama.cpp', logs: []
    });
    assert.equal(pub.displayName, 'Bryce-ALS-Q4_K_M');
    assert.equal(pub.params.thinkingMode, 'off');
    assert.notEqual(String(pub.displayName), 'undefined');
    assert.ok(pub.baseUrl.includes(':8081'));
  });

  test('capabilities summarize prefers reasoning-switch when probed', () => {
    const s = capabilities.summarize(
      { family: 'llama.cpp' },
      { probed: true, helpFlags: { thinking: true, reasoningSwitch: true, reasoningBudget: true, jinja: true }, devices: [] }
    );
    assert.equal(s.thinking, 'reasoning-switch');
    assert.equal(s.reasoningSwitch, true);
    assert.equal(s.reasoningBudget, true);
  });
});

describe('v1.2.2 conversation model persistence', () => {
  test('create + append backfill model; list resolves from messages when top-level missing', () => {
    const dir = tmpDir();
    const convs = new Conversations(dir, { info() {}, warn() {}, error() {} });
    const c = convs.create({ title: 't', model: null });
    assert.equal(c.model, null);
    const m1 = convs.appendMessage(c.id, { role: 'user', content: 'hello' });
    assert.equal(m1.model, null);
    const m2 = convs.appendMessage(c.id, {
      role: 'assistant', content: 'hi', model: 'Bryce-ALS-Q4_K_M',
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    });
    assert.equal(m2.model, 'Bryce-ALS-Q4_K_M');
    const listed = convs.list().find(x => x.id === c.id);
    assert.equal(listed.model, 'Bryce-ALS-Q4_K_M');
    const loaded = convs.get(c.id);
    assert.equal(loaded.model, 'Bryce-ALS-Q4_K_M');
  });

  test('missing model metadata stays null — never invents historical identity', () => {
    const dir = tmpDir();
    const convs = new Conversations(dir, { info() {}, warn() {}, error() {} });
    const c = convs.create({ title: 'orphan' });
    convs.appendMessage(c.id, { role: 'user', content: 'x' });
    convs.appendMessage(c.id, { role: 'assistant', content: 'y' });
    assert.equal(convs.list()[0].model, null);
  });

  test('setMeta updates conversation model for sidebar', () => {
    const dir = tmpDir();
    const convs = new Conversations(dir, { info() {}, warn() {}, error() {} });
    const c = convs.create({});
    convs.setMeta(c.id, { model: 'Bryce-ALS-Q4_K_M', engineId: 'llamacpp-cpu' });
    assert.equal(convs.list()[0].model, 'Bryce-ALS-Q4_K_M');
    assert.equal(convs.get(c.id).engineId, 'llamacpp-cpu');
  });

  test('undefined/null string models are treated as missing', () => {
    const dir = tmpDir();
    const convs = new Conversations(dir, { info() {}, warn() {}, error() {} });
    const c = convs.create({ model: 'undefined' });
    // Stored as given; resolver must still treat it as missing for list display.
    const file = path.join(dir, 'conversations', `conv-${c.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.model = 'undefined';
    raw.messages = [{ id: 'm1', role: 'assistant', content: 'x', model: 'null' }];
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(convs.list()[0].model, null);
  });
});

describe('v1.2.2 package version markers', () => {
  test('package.json and UI brand are v1.2.2', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.2.2');
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    assert.match(html, /v1\.2\.2/);
  });
});
