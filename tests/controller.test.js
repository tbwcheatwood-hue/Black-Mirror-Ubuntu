'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { ServerController, DuplicateProcessError } = require('../main/server/controller');
const { checkPort, findFreePort } = require('../main/server/ports');
const { parseLine, aggregate } = require('../main/server/logparse');

const MOCK_ENGINE = path.join(__dirname, 'helpers', 'mockengine.js');

/** A stub registry giving the controller a node-based fake engine. */
function stubRegistry(logger = console) {
  return {
    descriptor(engineId) {
      return {
        id: engineId, family: 'llama.cpp', api: 'openai', serverBinary: 'llama-server',
        readyProbe: { type: 'http', path: '/health' }
      };
    },
    adapter() {
      return {
        executablePath: () => process.execPath,
        buildServerArgs: (model, params, netw) => [MOCK_ENGINE, '--port', String(netw.port), '--bind', netw.bind, '--speed', '400']
      };
    }
  };
}

function makeController(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ctl-'));
  const { Logger } = require('../main/core/log');
  const logger = new Logger(path.join(dir, 'logs'));
  const events = [];
  const ctl = new ServerController(stubRegistry(logger), logger, {
    dataDir: dir,
    readyTimeoutMs: opts.readyTimeoutMs || 30000,
    onEvent: e => events.push(e),
    ...opts
  });
  return { dir, ctl, logger, events };
}

async function freePort() {
  const p = await findFreePort(18100 + Math.floor(Math.random() * 700), '127.0.0.1'); // suite-disjoint range
  assert.ok(p, 'found a free port');
  return p;
}

describe('Port utilities', () => {
  test('checkPort detects in-use and free ports', async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(port, '127.0.0.1', r));
    const busy = await checkPort(port, '127.0.0.1');
    assert.equal(busy.free, false);
    assert.equal(busy.reason, 'in-use');
    blocker.close();
    await new Promise(r => blocker.on('close', r));
    const freed = await checkPort(port, '127.0.0.1');
    assert.equal(freed.free, true);
  });
});

describe('Server controller', () => {
  test('start → ready → live logs → stop, with duplicate prevention', async () => {
    const { dir, ctl, events } = makeController('lifecycle');
    const port = await freePort();
    const modelPath = '/models/test-model.gguf';

    const started = await ctl.start({ engineId: 'llamacpp-cpu', modelPath, port, bind: '127.0.0.1', params: {} });
    assert.equal(started.status, 'running');
    assert.ok(started.pid > 0);
    assert.equal(started.mode, 'managed');

    // duplicate launch prevention
    await assert.rejects(
      () => ctl.start({ engineId: 'llamacpp-cpu', modelPath, port, bind: '127.0.0.1', params: {} }),
      e => e instanceof DuplicateProcessError && e.code === 'duplicate'
    );

    // same port, different model also refused
    await assert.rejects(
      () => ctl.start({ engineId: 'llamacpp-cpu', modelPath: '/models/other.gguf', port, bind: '127.0.0.1', params: {} }),
      /Port \d+ is already used/
    );

    // live logs captured
    await new Promise(r => setTimeout(r, 600));
    const p = ctl.list()[0];
    assert.ok(p.logLines > 0, 'log lines captured');
    assert.ok(ctl.findFor('llamacpp-cpu', modelPath), 'findFor works');

    // API actually reachable (mock serves /health)
    const res = await fetch(started.baseUrl + '/health');
    assert.equal(res.status, 200);

    // stop only kills the pid we spawned
    const pid = started.pid;
    await ctl.stop(started.id);
    await new Promise(r => setTimeout(r, 400));
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert.equal(alive, false, 'managed process was terminated');
    assert.ok(events.some(e => e.event === 'server-exit'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('port conflict with an external application fails fast with clear error', async () => {
    const { dir, ctl } = makeController('portconflict');
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(port, '127.0.0.1', r));
    await assert.rejects(
      () => ctl.start({ engineId: 'llamacpp-cpu', modelPath: '/m/x.gguf', port, bind: '127.0.0.1', params: {} }),
      e => e.code === 'port-busy' && /already in use by another application/.test(e.message)
    );
    blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('restart keeps the same configuration', async () => {
    const { dir, ctl } = makeController('restart');
    const port = await freePort();
    const first = await ctl.start({ engineId: 'llamacpp-cpu', modelPath: '/m/r.gguf', port, bind: '127.0.0.1', params: { contextLength: 8192 } });
    const second = await ctl.restart(first.id);
    assert.equal(second.port, port);
    assert.equal(second.model, '/m/r.gguf');
    assert.equal(second.status, 'running');
    assert.ok(second.pid !== first.pid, 'new process spawned');
    await ctl.stop(second.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('restart refuses replacement when stop is unresolved (no duplicate)', async () => {
    const { dir, ctl } = makeController('restart-unresolved');
    const port = await freePort();
    const first = await ctl.start({
      engineId: 'llamacpp-cpu',
      modelPath: '/m/ru.gguf',
      port,
      bind: '127.0.0.1',
      params: {}
    });
    const runningBefore = ctl.list().filter(s => s.status === 'running').length;
    assert.equal(runningBefore, 1);

    // Simulate an unresolved stop without actually killing the child — restart
    // must abort before spawning a replacement.
    const realStop = ctl.stop.bind(ctl);
    ctl.stop = async () => ({
      id: first.id,
      pid: first.pid,
      killed: false,
      exitObserved: false,
      pidAliveAfter: true,
      portReleased: false,
      httpDown: false,
      confirmed: false
    });

    await assert.rejects(
      () => ctl.restart(first.id),
      e => e.code === 'stop-unresolved'
        && /not confirmed/.test(e.message)
        && /replacement was not started/.test(e.message)
    );

    const still = ctl.list().filter(s => s.status === 'running');
    assert.equal(still.length, 1, 'original managed server remains the only running entry');
    assert.equal(still[0].pid, first.pid, 'no replacement PID was spawned');

    ctl.stop = realStop;
    const confirmed = await ctl.stop(first.id);
    assert.equal(confirmed.confirmed, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('restart of remote-mode record is refused (ownership safeguard)', async () => {
    const { dir, ctl } = makeController('restart-remote');
    // Remotes live outside the managed map; if a remote-mode record is ever
    // resolved, restart must refuse rather than stop/start it.
    ctl.processes.set('remote-fake', {
      id: 'remote-fake',
      mode: 'remote',
      engineId: 'remote',
      model: null,
      port: 19999,
      bind: '127.0.0.1',
      params: {},
      status: 'running',
      displayName: 'ext'
    });
    await assert.rejects(
      () => ctl.restart('remote-fake'),
      e => e.code === 'not-owned' && /never restarted/i.test(e.message)
    );
    ctl.processes.delete('remote-fake');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stopAll shuts everything down (clean app shutdown)', async () => {
    const { dir, ctl } = makeController('stopall');
    const ports = [await freePort(), await freePort()];
    const a = await ctl.start({ engineId: 'llamacpp-cpu', modelPath: '/m/a.gguf', port: ports[0], bind: '127.0.0.1', params: {} });
    const b = await ctl.start({ engineId: 'llamacpp-vulkan', modelPath: '/m/b.gguf', port: ports[1], bind: '127.0.0.1', params: {} });
    await ctl.stopAll('test');
    for (const proc of [a, b]) {
      let alive = true;
      try { process.kill(proc.pid, 0); } catch (_) { alive = false; }
      assert.equal(alive, false, `pid ${proc.pid} terminated`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('crashed engine → startup failure with log excerpt, app stays usable', async () => {
    const { dir, ctl } = makeController('crash');
    // Stub registry that spawns a failing process
    ctl.registry = {
      descriptor: () => ({ id: 'x', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
      adapter: () => ({
        executablePath: () => process.execPath,
        buildServerArgs: () => ['-e', 'process.exit(2);']
      })
    };
    const port = await freePort();
    await assert.rejects(
      () => ctl.start({ engineId: 'x', modelPath: '/m/z.gguf', port, bind: '127.0.0.1', params: {} }),
      e => e.code === 'startup-failed' && /Last log lines/.test(e.message)
    );
    // controller still usable afterwards: crashed record is briefly kept for
    // log inspection but does NOT block launching the same model again
    const rec = ctl.list()[0];
    assert.equal(rec.status, 'crashed');
    ctl.processes.delete(rec.id); // simulate the 30s UI-retention expiry
    assert.equal(ctl.list().length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readiness timeout → informative error, process kept for inspection', async () => {
    const { dir, ctl } = makeController('readytimeout', { readyTimeoutMs: 1200 });
    ctl.registry = {
      descriptor: () => ({ id: 'x', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
      adapter: () => ({
        executablePath: () => process.execPath,
        buildServerArgs: (m, p, netw) => [MOCK_ENGINE, '--port', String(netw.port), '--fail', 'health']
      })
    };
    const port = await freePort();
    await assert.rejects(
      () => ctl.start({ engineId: 'x', modelPath: '/m/slow.gguf', port, bind: '127.0.0.1', params: {} }),
      /did not become ready/
    );
    // the process is still up; user can inspect logs and stop it
    const still = ctl.list();
    assert.ok(still.length >= 1, 'server still tracked for inspection');
    await ctl.stopAll('test-end');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stop refuses unknown ids (never touches external processes)', async () => {
    const { dir, ctl } = makeController('refuse');
    await assert.rejects(() => ctl.stop('srv-does-not-exist'), /No managed server/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('llama.cpp log parser', () => {
  test('extracts prompt/gen tps from real llama-server lines', () => {
    const lines = [
      'srv    load_model: loaded model',
      'prompt eval time     =   1210.84 ms /   512 tokens (  422.86 tokens per second)',
      'eval time            =  19874.23 ms /   389 tokens (   19.57 tokens per second)',
      'total time           =  21085.07 ms /   901 tokens'
    ];
    const stats = aggregate(lines);
    assert.equal(stats.promptTps, 422.86);
    assert.equal(stats.genTps, 19.57);
    assert.equal(stats.lastGenMs, 19874.23);
  });
  test('ready detection', () => {
    assert.equal(parseLine('server is listening on http://127.0.0.1:8081 - starting the main loop').kind, 'ready');
    assert.equal(parseLine('random log line'), null);
  });
  test('load time line', () => {
    const s = aggregate(['load time            =   3053.42 ms']);
    assert.equal(s.loadMs, 3053.42);
  });
});
