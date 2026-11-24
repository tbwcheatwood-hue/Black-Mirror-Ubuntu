'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EngineRegistry } = require('../main/engines/registry');
const { LlamaCppAdapter, OllamaAdapter, LemonadeAdapter, PARAM_SCHEMA, EngineError, createAdapter } = require('../main/engines/adapters');
const { EngineInstaller } = require('../main/engines/installer');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-eng-' + name + '-'));
}

function makeRegistry(t, opts = {}) {
  const dir = tmpdir(t);
  const reg = new EngineRegistry(dir, console, {
    builtinDir: opts.builtinDir || path.join(__dirname, '..', 'main', 'engines', 'builtin'),
    fetchImpl: opts.fetchImpl,
    osFilter: opts.osFilter ?? false // tests run on any platform
  });
  return { dir, reg };
}

describe('Engine registry', () => {
  test('loads five builtin descriptors on win32-capable filter', () => {
    const { dir, reg } = makeRegistry('load');
    const ids = reg.descriptors().map(d => d.id);
    assert.ok(ids.includes('llamacpp-cpu'));
    assert.ok(ids.includes('llamacpp-vulkan'));
    assert.ok(ids.includes('llamacpp-sycl'));
    assert.ok(ids.includes('ollama'));
    assert.ok(ids.includes('lemonade'));
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('version registration, multiple versions, activation and rollback', () => {
    const { dir, reg } = makeRegistry('ver');
    reg.registerVersion('llamacpp-vulkan', 'b12300', '/fake/dir/a');
    reg.registerVersion('llamacpp-vulkan', 'b12400', '/fake/dir/b');
    const st = reg.state('llamacpp-vulkan');
    assert.equal(st.versions.length, 2);
    assert.equal(st.activeTag, 'b12400'); // newest installed is active
    // rollback to the older one
    reg.setActiveVersion('llamacpp-vulkan', 'b12300');
    assert.equal(reg.state('llamacpp-vulkan').activeTag, 'b12300');
    assert.equal(reg.activeVersionDir('llamacpp-vulkan'), '/fake/dir/a');
    // rollback target missing → error
    assert.throws(() => reg.setActiveVersion('llamacpp-vulkan', 'b99999'), /not installed/);
    // re-register same tag updates in place
    reg.registerVersion('llamacpp-vulkan', 'b12300', '/fake/dir/a2');
    assert.equal(reg.state('llamacpp-vulkan').versions.length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('unknown engine raises a clear error', () => {
    const { dir, reg } = makeRegistry('unknown');
    assert.throws(() => reg.descriptor('nope-engine'), /Unknown engine/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('status(): uninstalled engine reported as not-installed with helpful error', async () => {
    const { dir, reg } = makeRegistry('status');
    const status = await reg.status();
    const cpu = status.find(s => s.id === 'llamacpp-cpu');
    assert.equal(cpu.installed, false);
    assert.equal(cpu.status, 'not-installed');
    assert.ok(cpu.error && /Install it|not found/i.test(cpu.error), 'has guidance text');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('status(): customPath registration marks installed', async () => {
    const { dir, reg } = makeRegistry('custom');
    reg.setCustomPath('ollama', process.execPath); // node binary as a stand-in "ollama"
    const status = await reg.status();
    const ol = status.find(s => s.id === 'ollama');
    assert.equal(ol.installed, true);
    assert.equal(ol.customPath, process.execPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('llama.cpp adapter argument mapping', () => {
  const d = { id: 'llamacpp-cpu', family: 'llama.cpp', serverBinary: 'llama-server', versionProbe: { args: ['--version'], regex: 'version:\\s*(\\d+)\\s*\\((\\w+)\\)' } };
  const a = new LlamaCppAdapter(d, { activeVersionDir: '/engines/dir' });

  test('context length is passed EXACTLY — never silently reduced', () => {
    const args = a.buildServerArgs('/m/model.gguf', { contextLength: 47777 }, { port: 8081, bind: '127.0.0.1' });
    const i = args.indexOf('--ctx-size');
    assert.notEqual(i, -1, '--ctx-size present');
    assert.equal(args[i + 1], '47777', 'exact context value passes through');
  });

  test('all core parameters map to the correct flags', () => {
    const args = a.buildServerArgs('/m/x.gguf', {
      contextLength: 16384, threads: 6, threadsBatch: 8, gpuLayers: 12,
      batchSize: 1024, parallelSlots: 2, kvCacheType: 'q8_0',
      useMmap: false, flashAttention: true, thinkingMode: 'on', cpuMoeLayers: 10,
      extraArgs: '--verbose-prompt'
    }, { port: 9000, bind: '0.0.0.0' });
    const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
    assert.equal(get('--ctx-size'), '16384');
    assert.equal(get('--threads'), '6');
    assert.equal(get('--threads-batch'), '8');
    assert.equal(get('--n-gpu-layers'), '12');
    assert.equal(get('--batch-size'), '1024');
    assert.equal(get('--parallel'), '2');
    assert.equal(get('--cache-type-k'), 'q8_0');
    assert.equal(get('--cache-type-v'), 'q8_0');
    assert.equal(get('--host'), '0.0.0.0');
    assert.equal(get('--port'), '9000');
    assert.ok(args.includes('--no-mmap'));
    assert.ok(args.includes('--flash-attn'));
    assert.deepEqual(args.slice(args.indexOf('--reasoning-format'), args.indexOf('--reasoning-format') + 2), ['--reasoning-format', 'deepseek']);
    assert.equal(get('--n-cpu-moe'), '10');
    assert.ok(args.includes('--verbose-prompt'));
  });

  test('kv f16 default emits no cache-type flags', () => {
    const args = a.buildServerArgs('/m/x.gguf', { contextLength: 4096, kvCacheType: 'f16' }, { port: 1, bind: '127.0.0.1' });
    assert.ok(!args.includes('--cache-type-k'));
  });

  test('request overrides map sampling params', () => {
    const ov = a.buildRequestOverrides({ temperature: 0.7, topP: 0.9, topK: 60, repeatPenalty: 1.15, maxTokens: 512 });
    assert.deepEqual(ov, { temperature: 0.7, top_p: 0.9, top_k: 60, repeat_penalty: 1.15, max_tokens: 512 });
  });

  test('version output parsing from real llama-server format', () => {
    const out = 'ggml_cuda_init: found 0 CUDA devices\nversion: 5132 (8f3c21d)\nbuilt with MSVC';
    assert.deepEqual(LlamaCppAdapter.parseVersionOutput(out, 'version:\\s*(\\d+)\\s*\\((\\w+)\\)'), { build: '5132', commit: '8f3c21d', label: 'b5132 (8f3c21d)' });
    assert.equal(LlamaCppAdapter.parseVersionOutput('garbage', 'version:\\s*(\\d+)'), null);
  });

  test('executable missing → EngineError with guidance, not a crash', () => {
    const a2 = new LlamaCppAdapter(d, { activeVersionDir: null, customPath: null });
    assert.throws(() => a2.executablePath(), e => e instanceof EngineError && e.code === 'binary-missing');
    const a3 = new LlamaCppAdapter(d, { customPath: '/definitely/not/here/llama-server.exe' });
    assert.throws(() => a3.executablePath(), /Configured executable not found/);
  });
});

describe('Ollama adapter', () => {
  const d = { id: 'ollama', family: 'ollama', versionProbe: { args: ['--version'], regex: 'ollama version is\\s+(\\S+)' } };
  test('num_ctx passes exact context; thinking flag maps to request body', () => {
    const a = new OllamaAdapter(d, {});
    const ov = a.buildRequestOverrides({ contextLength: 33333, temperature: 0.5, maxTokens: 128 }, 'llama3', 'on');
    assert.equal(ov.options.num_ctx, 33333);
    assert.equal(ov.options.temperature, 0.5);
    assert.equal(ov.options.num_predict, 128);
    assert.equal(ov.think, true);
  });

  test('thinkingMode off sends EXPLICIT think:false (models that think by default)', () => {
    const a = new OllamaAdapter(d, {});
    const off = a.buildRequestOverrides({ contextLength: 8192 }, 'llama3', 'off');
    assert.equal(off.think, false, 'disabling thinking must request think:false, not omit it');
    const auto = a.buildRequestOverrides({ contextLength: 8192 }, 'llama3', 'auto');
    assert.equal('think' in auto, false, 'auto leaves the engine default untouched');
  });
  test('listModels reads /api/tags (ollama registry shape)', async () => {
    const a = new OllamaAdapter(d, {});
    const fake = async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:8b', size: 5e9, details: { quantization_level: 'Q4_K_M', family: 'qwen2', parameter_size: '8.2B' } }] })
    });
    const models = await a.listModels('http://x', fake);
    assert.equal(models[0].id, 'qwen3:8b');
    assert.equal(models[0].quant, 'Q4_K_M');
  });
  test('version parsing', () => {
    assert.deepEqual(OllamaAdapter.parseVersionOutput('ollama version is 0.40.17', 'ollama version is\\s+(\\S+)'), { build: '0.40.17', commit: null, label: '0.40.17' });
  });
});

describe('Lemonade adapter', () => {
  const d = { id: 'lemonade', family: 'lemonade', versionProbe: { args: ['-v'], regex: '([0-9]+\\.[0-9]+\\.[0-9]+)' } };
  test('serve args with port', () => {
    const a = new LemonadeAdapter(d, {});
    const args = a.buildServerArgs(null, {}, { port: 8000, bind: '127.0.0.1' });
    assert.ok(args.includes('serve') && args.includes('--port'));
  });
  test('listModels handles array and wrapped shapes', async () => {
    const a = new LemonadeAdapter(d, {});
    const models = await a.listModels('http://x', async () => ({
      ok: true, json: async () => ({ data: [{ id: 'Llama-3.2-1B-Instruct-Hybrid' }] })
    }));
    assert.equal(models[0].id, 'Llama-3.2-1B-Instruct-Hybrid');
  });
});

describe('Param schema', () => {
  test('covers all required user-configurable parameters', () => {
    const ids = PARAM_SCHEMA.map(p => p.id);
    for (const required of ['contextLength', 'threads', 'gpuLayers', 'batchSize', 'parallelSlots', 'temperature', 'topP', 'topK', 'repeatPenalty', 'maxTokens', 'kvCacheType', 'useMmap', 'flashAttention', 'thinkingMode']) {
      assert.ok(ids.includes(required), `schema includes ${required}`);
    }
  });
});

describe('Engine installer (mock network)', () => {
  function makeFakeZip() {
    // Build a real zip the installer can Expand-Archive / unzip.
    // Include both platform spellings: staged-binary validation expects the
    // name matching the host platform (llama-server on POSIX, .exe on Windows).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-zip-'));
    const exe = path.join(tmp, 'llama-server.exe');
    fs.writeFileSync(exe, 'MZfakebinary');
    fs.writeFileSync(path.join(tmp, 'llama-server'), '#!/bin/sh\nMZfakebinary');
    const zip = path.join(tmp, 'fake.zip');
    const { spawnSync, execSync } = require('child_process');
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -LiteralPath @('${exe.replace(/'/g, "''")}','${path.join(tmp, 'llama-server').replace(/'/g, "''")}') -DestinationPath '${zip.replace(/'/g, "''")}' -Force`
      ], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) throw new Error(`Compress-Archive failed: ${r.stderr || r.stdout || r.status}`);
    } else {
      try {
        execSync(`cd ${JSON.stringify(tmp)} && zip -q fake.zip llama-server.exe llama-server`);
      } catch (_) {
        execSync(`python3 - <<'PY'\nimport zipfile\nz=zipfile.ZipFile(${JSON.stringify(zip)},'w')\nz.write(${JSON.stringify(path.join(tmp,'llama-server.exe'))},'llama-server.exe')\nz.write(${JSON.stringify(path.join(tmp,'llama-server'))},'llama-server')\nz.close()\nPY`);
      }
    }
    return { zip, tmp };
  }

  test('resolveTag via stable pointer, install→register→uninstall roundtrip', async () => {
    const { zip, tmp: zipTmp } = makeFakeZip();
    const { dir, reg } = makeRegistry('inst');
    // Override builtin dir: use our own minimal descriptor so the installer has real templates.
    const descDir = path.join(dir, 'desc');
    fs.mkdirSync(descDir);
    const descriptor = {
      id: 'llamacpp-vulkan', family: 'llama.cpp', displayName: 'Vulkan', acceleration: 'gpu-vulkan',
      os: [process.platform], serverBinary: 'llama-server', api: 'openai',
      install: {
        type: 'github-release-zip',
        repo: 'ggml-org/llama.cpp',
        assetTemplate: 'llama-{tag}-bin-win-vulkan-x64.zip',
        stableTagPointer: 'http://local/nightly-tag.txt'
      },
      versionProbe: { type: 'cli', args: ['--version'], regex: 'version:\\s*(\\d+)' },
      readyProbe: { type: 'http', path: '/health' }, defaultPort: 8082, defaultBind: '127.0.0.1'
    };
    fs.writeFileSync(path.join(descDir, 'test-vulkan.json'), JSON.stringify(descriptor));

    let tagFetches = 0;
    const fetchImpl = async (url) => {
      if (url.includes('nightly-tag.txt')) {
        tagFetches++;
        return { ok: true, text: async () => 'b12359\n' };
      }
      if (url.endsWith('llama-b12359-bin-win-vulkan-x64.zip')) {
        const data = fs.readFileSync(zip);
        return {
          ok: true, status: 200,
          headers: new Map([['content-length', String(data.length)]]),
          body: (() => {
            const { Readable } = require('stream');
            return Readable.toWeb(Readable.from(data));
          })()
        };
      }
      throw new Error('unexpected url ' + url);
    };
    const reg2 = new EngineRegistry(dir, console, { builtinDir: descDir, fetchImpl });
    const installer = new EngineInstaller(reg2, console, { fetchImpl });

    const resolved = await installer.resolveTag(descriptor, null);
    assert.equal(resolved.tag, 'b12359', 'stable pointer tag resolved');
    assert.equal(resolved.via, 'stable-pointer');
    assert.equal(tagFetches, 1);

    const res = await installer.install('llamacpp-vulkan', {});
    assert.equal(res.tag, 'b12359');
    const exePath = path.join(res.dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server.exe');
    assert.ok(fs.existsSync(exePath), 'extracted binary exists');
    const st = reg2.state('llamacpp-vulkan');
    assert.equal(st.activeTag, 'b12359');
    assert.equal(st.versions.length, 1);

    // install again → alreadyInstalled no-op
    const res2 = await installer.install('llamacpp-vulkan', {});
    assert.equal(res2.alreadyInstalled, true);
    assert.equal(reg2.state('llamacpp-vulkan').versions.length, 1);

    // uninstall refuses paths outside engines dir
    reg2.registerVersion('llamacpp-vulkan', 'evil', '/etc', { activate: false });
    assert.throws(() => installer.uninstall('llamacpp-vulkan', 'evil'), /Refusing to remove/);
    // uninstall real version works
    installer.uninstall('llamacpp-vulkan', 'b12359');
    assert.equal(reg2.state('llamacpp-vulkan').versions.length, 1);
    assert.ok(!fs.existsSync(res.dir), 'removed from disk');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(zipTmp, { recursive: true, force: true });
  });

  test('explicit tag wins over stable pointer', async () => {
    const { dir, reg } = makeRegistry('tag2');
    const descriptor = {
      id: 'llamacpp-cpu', family: 'llama.cpp', os: [process.platform], install: {
        type: 'github-release-zip', repo: 'ggml-org/llama.cpp',
        assetTemplate: 'llama-{tag}-bin-win-cpu-x64.zip',
        stableTagPointer: 'http://local/nightly-tag.txt'
      }
    };
    const descDir = path.join(dir, 'desc');
    fs.mkdirSync(descDir);
    fs.writeFileSync(path.join(descDir, 'cpu.json'), JSON.stringify(descriptor));
    const reg2 = new EngineRegistry(dir, console, { builtinDir: descDir });
    const installer = new EngineInstaller(reg2, console, { fetchImpl: async () => { throw new Error('network should not be needed'); } });
    const resolved = await installer.resolveTag(descriptor, 'b11000');
    assert.equal(resolved.tag, 'b11000');
    assert.equal(resolved.via, 'explicit');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('adapter factory rejects unknown family', () => {
    assert.throws(() => createAdapter({ family: 'magic-engine' }, {}), /Unknown engine family/);
  });
});
