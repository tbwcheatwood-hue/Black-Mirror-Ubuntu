'use strict';
/* Attach-lifecycle engines (LM Studio): the engine runs its own server, so the
 * controller connects to it instead of spawning a process it can kill. */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ServerController, DuplicateProcessError } = require('../main/server/controller');
const { EngineRegistry } = require('../main/engines/registry');
const { LmStudioAdapter } = require('../main/engines/adapters');

/** LM Studio-shaped library, as /api/v0/models reports it. */
const LIBRARY = [
  { id: 'qwen3.5-9b', type: 'vlm', state: 'loaded', quantization: 'Q4_K_M', arch: 'qwen35' },
  { id: 'ibm/granite-3.2-8b', type: 'llm', state: 'not-loaded', quantization: 'Q4_K_M', arch: 'granite' },
  { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', state: 'not-loaded' }
];

function attachRegistry() {
  const descriptor = {
    id: 'lmstudio', family: 'lmstudio', api: 'openai', serverBinary: 'lms',
    displayName: 'LM Studio', lifecycle: 'attach'
  };
  return { descriptor: () => descriptor, adapter: () => new LmStudioAdapter(descriptor, {}) };
}

function makeController(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-attach-'));
  const { Logger } = require('../main/core/log');
  const logger = new Logger(path.join(dir, 'logs'));
  const events = [];
  const ctl = new ServerController(attachRegistry(), logger, { dataDir: dir, fetchImpl, onEvent: e => events.push(e) });
  return { dir, ctl, logger, events };
}

const online = async () => ({ ok: true, status: 200, json: async () => ({ data: LIBRARY }) });
const offline = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234'); };
const attach = (ctl, modelPath) => ctl.start({ engineId: 'lmstudio', modelPath, port: 1234, bind: '127.0.0.1', params: {} });
const cleanup = c => { if (c.logger.close) c.logger.close(); fs.rmSync(c.dir, { recursive: true, force: true }); };

describe('attach-lifecycle engines (LM Studio)', () => {
  test('adapter lists chat models with load state and leaves embeddings out', async () => {
    const seen = [];
    const list = await new LmStudioAdapter({ id: 'lmstudio' }, {}).listModels('http://127.0.0.1:1234', async url => { seen.push(url); return online(); });
    assert.deepEqual(seen, ['http://127.0.0.1:1234/api/v0/models']);
    assert.deepEqual(list.map(m => m.id), ['qwen3.5-9b', 'ibm/granite-3.2-8b']);
    assert.equal(list[0].state, 'loaded');
    assert.equal(list[1].quant, 'Q4_K_M');
    assert.equal(list[1].architecture, 'granite');
  });

  test('attaches without spawning: no pid, mode attached, model key kept as identity', async () => {
    const c = makeController(online);
    const p = await c.ctl.start({ engineId: 'lmstudio', modelPath: 'ibm/granite-3.2-8b', port: 1234, bind: '127.0.0.1', params: {}, modelDisplayName: 'granite-3.2-8b' });
    assert.equal(p.pid, null, 'nothing was spawned');
    assert.equal(p.mode, 'attached');
    assert.equal(p.status, 'running');
    assert.equal(p.model, 'ibm/granite-3.2-8b');
    assert.equal(p.displayName, 'ibm/granite-3.2-8b', 'requests carry the engine model key, not a shortened label');
    assert.equal(p.baseUrl, 'http://127.0.0.1:1234');
    assert.equal(c.ctl.list().length, 1);
    assert.ok(c.events.some(e => e.event === 'server-ready'));
    await assert.rejects(() => attach(c.ctl, 'ibm/granite-3.2-8b'), DuplicateProcessError);
    cleanup(c);
  });

  test('stop only detaches — the engine-run server is never touched', async () => {
    const c = makeController(online);
    const p = await attach(c.ctl, 'qwen3.5-9b');
    const r = await c.ctl.stop(p.id);
    assert.equal(r.detached, true);
    assert.equal(r.killed, false, 'nothing was killed');
    assert.equal(r.confirmed, true);
    assert.equal(c.ctl.list().length, 0);
    assert.ok(c.events.some(e => e.event === 'server-exit'));
    cleanup(c);
  });

  test('restart re-attaches with the same configuration', async () => {
    const c = makeController(online);
    const first = await attach(c.ctl, 'qwen3.5-9b');
    const second = await c.ctl.restart(first.id);
    assert.equal(second.model, 'qwen3.5-9b');
    assert.equal(second.port, 1234);
    assert.equal(second.mode, 'attached');
    assert.equal(second.status, 'running');
    assert.equal(c.ctl.list().length, 1);
    cleanup(c);
  });

  test('unreachable engine server fails with guidance and records nothing', async () => {
    const c = makeController(offline);
    await assert.rejects(
      () => attach(c.ctl, 'qwen3.5-9b'),
      e => e.code === 'unreachable' && /not reachable/.test(e.message) && /lms server start/.test(e.message)
    );
    assert.equal(c.ctl.list().length, 0);
    cleanup(c);
  });

  test('a model the engine does not have is refused', async () => {
    const c = makeController(online);
    await assert.rejects(() => attach(c.ctl, 'not/a-model'), e => e.code === 'unknown-model');
    assert.equal(c.ctl.list().length, 0);
    cleanup(c);
  });

  test('registry reports the lifecycle for descriptors loaded from engines.d', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-attach-reg-'));
    const registry = new EngineRegistry(dir, null, { builtinDir: path.join(dir, 'no-builtins') });
    fs.mkdirSync(path.join(dir, 'engines.d'));
    fs.writeFileSync(path.join(dir, 'engines.d', 'lmstudio.json'), JSON.stringify({
      id: 'lmstudio', family: 'lmstudio', displayName: 'LM Studio', serverBinary: 'lms', lifecycle: 'attach',
      os: [process.platform], versionProbe: { type: 'cli', args: ['version'], regex: '(\\w+)' }
    }));
    const [st] = await registry.status();
    assert.equal(st.id, 'lmstudio');
    assert.equal(st.lifecycle, 'attach');
    assert.equal(st.install, undefined, 'nothing to install for an engine that runs its own server');
    assert.equal(st.installed, false);
    registry.setCustomPath('lmstudio', process.execPath);
    assert.equal((await registry.status())[0].installed, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
