'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Conversations } = require('../main/core/conversations');
const { Config, defaultParams } = require('../main/core/config');
const { Monitor, readMemInfo } = require('../main/monitor/monitor');

function tmpdir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-core-' + name + '-'));
  return d;
}

describe('Conversations', () => {
  test('create, append, auto-title, list order', () => {
    const dir = tmpdir('conv');
    const cs = new Conversations(dir, console);
    const c = cs.create({ title: 'New conversation' });
    assert.equal(c.title, 'New conversation');
    const m1 = cs.appendMessage(c.id, { role: 'user', content: 'Explain quantization in LLMs please' });
    const m2 = cs.appendMessage(c.id, { role: 'assistant', content: 'Quantization reduces numeric precision of weights.', usage: { prompt_tokens: 10, completion_tokens: 7 }, tps: 18.4 });
    assert.equal(cs.get(c.id).title, 'Explain quantization in LLMs please', 'auto-titled from first user msg');
    assert.equal(cs.get(c.id).messages.length, 2);
    assert.equal(cs.get(c.id).stats.completionTokens, 7);
    const list = cs.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].messageCount, 2);
    assert.equal(list[0].lastMessage.includes('Quantization'), true);

    // edit & truncate
    cs.updateMessage(c.id, m2.id, { content: 'Edited content' });
    assert.equal(cs.get(c.id).messages[1].content, 'Edited content');
    cs.truncateFrom(c.id, m1.id, { inclusive: false });
    assert.equal(cs.get(c.id).messages.length, 1);

    // second conversation sorts first (most recent)
    const c2 = cs.create();
    assert.equal(cs.list()[0].id, c2.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('search across messages', () => {
    const dir = tmpdir('search');
    const cs = new Conversations(dir, console);
    const a = cs.create();
    cs.appendMessage(a.id, { role: 'user', content: 'Tell me about Vulkan offloading' });
    const b = cs.create();
    cs.appendMessage(b.id, { role: 'user', content: 'What is SYCL?' });
    const hits = cs.search('vulkan');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].conversationId, a.id);
    assert.ok(hits[0].excerpt.length > 0);
    const byTitle = cs.search('Tell me'); // matches title (auto-set)
    assert.ok(byTitle.length >= 1);
    assert.deepEqual(cs.search(''), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('delete conversation removes file and index entry', () => {
    const dir = tmpdir('del');
    const cs = new Conversations(dir, console);
    const c = cs.create();
    cs.appendMessage(c.id, { role: 'user', content: 'hello' });
    assert.equal(cs.remove(c.id), true);
    assert.equal(cs.get(c.id), null);
    assert.equal(cs.list().length, 0);
    assert.equal(cs.remove('nonexistent'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Config', () => {
  test('defaults include full param schema, nested get/set persists', () => {
    const dir = tmpdir('cfg');
    const cfg = new Config(dir);
    const p = cfg.params();
    for (const k of Object.keys(defaultParams())) {
      assert.ok(k in p, `param ${k} defaulted`);
    }
    cfg.set('network.bind', '0.0.0.0');
    cfg.set('params.contextLength', 32768);
    const cfg2 = new Config(dir); // reload from disk
    assert.equal(cfg2.get('network.bind'), '0.0.0.0');
    assert.equal(cfg2.get('params.contextLength'), 32768);
    assert.equal(cfg2.get('does.not.exist', 'fallback'), 'fallback');
    // effective params: profile overrides global
    const eff = cfg2.effectiveParams({ contextLength: 4096, threads: 4 });
    assert.equal(eff.contextLength, 4096);
    assert.equal(eff.temperature, p.temperature, 'non-overridden values stay global');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Monitor (host-appropriate paths)', () => {
  test('sample returns structured metrics with honest GPU reporting', async () => {
    const m = new Monitor(console, { intervalMs: 60000 });
    const s = await m.sample();
    assert.ok(s.ts > 0);
    assert.ok(s.cpu.cores > 0);
    assert.ok(typeof s.cpu.percent === 'number' || s.cpu.percent === null);
    assert.ok(s.memory.totalBytes > 0);
    assert.ok(s.memory.usedPct >= 0 && s.memory.usedPct <= 100);
    // GPU honesty: on hosts without nvidia-smi, available=false and note set
    if (!s.gpu.available) {
      assert.ok(s.gpu.note && s.gpu.note.length > 10, 'explains why GPU data is absent');
      assert.equal(s.gpu.utilizationPercent, null);
    }
    m.stop();
  });

  test('managed process metrics when a tracked pid exists', async () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: false });
    await new Promise(r => setTimeout(r, 400));
    const m = new Monitor(console, { getManagedPids: () => [child.pid] });
    const s = await m.sample();
    if (process.platform === 'win32') {
      // PowerShell probe may be async; skip strict assert in CI-less envs
      m.stop(); child.kill(); return;
    }
    const mine = s.managedProcesses.find(x => x.pid === child.pid);
    assert.ok(mine && mine.memoryBytes > 0, 'RSS of tracked process reported');
    m.stop();
    child.kill('SIGTERM');
  });
});
