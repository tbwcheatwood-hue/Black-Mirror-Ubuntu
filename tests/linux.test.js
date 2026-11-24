'use strict';
/**
 * Ubuntu-edition regression tests.
 * These run on the Linux host the suite is executed on. They do not claim
 * that CUDA/ROCm/Vulkan inference works — no GPU result is fabricated.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseCpuInfo, parseMemInfo, parseNvidiaSmi, probeHardware } = require('../main/monitor/linuxprobe');
const { killOwnedTree } = require('../main/server/proctree');
const { snapshotProcess, verifyOwnership, isAlive } = require('../main/server/ownership');
const { assessCompatibility, STATUS } = require('../main/compatlab/assessor');
const { EngineRegistry } = require('../main/engines/registry');
const { EngineInstaller } = require('../main/engines/installer');
const { defaultAppDataDir, findInstalledBinary } = require('../main/core/util');
const { LlamaCppAdapter } = require('../main/engines/adapters');
const { ServerController } = require('../main/server/controller');
const { Logger } = require('../main/core/log');

const CPUINFO = `
processor	: 0
physical id	: 0
core id		: 0
model name	: Test CPU
flags		: fpu sse4_2 avx avx2 fma

processor	: 1
physical id	: 0
core id		: 1
model name	: Test CPU
flags		: fpu sse4_2 avx avx2 fma

processor	: 2
physical id	: 0
core id		: 0
model name	: Test CPU
flags		: fpu sse4_2 avx avx2 fma
`;

describe('Linux hardware probe', () => {
  test('parses cpu topology and instruction flags without inventing extras', () => {
    const cpu = parseCpuInfo(CPUINFO);
    assert.equal(cpu.model, 'Test CPU');
    assert.equal(cpu.logicalThreads, 3);
    assert.equal(cpu.physicalCores, 2);
    assert.ok(cpu.flags.includes('avx2'));
    assert.ok(!cpu.flags.includes('avx512f'));
  });

  test('parses meminfo including swap', () => {
    const mem = parseMemInfo('MemTotal: 1000000 kB\nMemAvailable: 400000 kB\nMemFree: 100000 kB\nSwapTotal: 200000 kB\nSwapFree: 50000 kB\n');
    assert.equal(mem.totalBytes, 1000000 * 1024);
    assert.equal(mem.availableBytes, 400000 * 1024);
    assert.equal(mem.swapUsedBytes, 150000 * 1024);
  });

  test('marks Tesla K80 class compute capability as legacy and does not invent VRAM', () => {
    const gpus = parseNvidiaSmi('Tesla K80, 11441 MiB, 470.82.01, 3.7\n');
    assert.equal(gpus.length, 1);
    assert.equal(gpus[0].computeCapability, '3.7');
    assert.equal(gpus[0].computeMajor, 3);
    assert.equal(gpus[0].name, 'Tesla K80');
  });

  test('probe does not claim vulkan/rocm/sycl when those tools are not invoked', () => {
    const hw = probeHardware({
      cpuinfo: CPUINFO,
      meminfo: 'MemTotal: 8192 kB\nMemAvailable: 4096 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
      deep: false,
      skipNvidia: true,
      noLscpu: true,
      existsSync: () => false,
      readdirSync: () => [],
      readFileSync: () => { throw new Error('no sysfs'); }
    });
    assert.equal(hw.vulkan, 'unknown');
    assert.equal(hw.rocm, 'unknown');
    assert.equal(hw.sycl, 'unknown');
    assert.equal(hw.gpus.length, 0);
    assert.equal(hw.cpu.isa.avx2, true);
    assert.equal(hw.cpu.isa.avx512f, false);
  });

  test('live probe reports this machine without throwing', () => {
    const hw = probeHardware({ deep: true });
    assert.equal(hw.platform, 'linux');
    assert.ok(hw.memory.totalBytes > 0);
    assert.ok(Array.isArray(hw.gpus));
    for (const g of hw.gpus) {
      assert.ok(g.vendor, 'every reported gpu has a vendor from sysfs or nvidia-smi');
    }
  });
});

describe('Linux engine descriptors and assets', () => {
  test('linux filter exposes cpu, vulkan, cuda, rocm, sycl, ollama and lemonade', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lxdesc-'));
    const reg = new EngineRegistry(dir, console, { osFilter: 'linux' });
    const ids = reg.descriptors().map(d => d.id);
    for (const id of ['llamacpp-cpu', 'llamacpp-vulkan', 'llamacpp-cuda12', 'llamacpp-cuda13', 'llamacpp-rocm', 'llamacpp-sycl', 'llamacpp-sycl-fp16', 'ollama', 'lemonade']) {
      assert.ok(ids.includes(id), id);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('resolveAsset on linux selects the ubuntu cpu tarball', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lxasset-'));
    const reg = new EngineRegistry(dir, console, { osFilter: 'linux' });
    const d = reg.descriptor('llamacpp-cpu');
    const installer = new EngineInstaller(reg, console, {
      fetchImpl: async () => ({ ok: true, status: 200 })
    });
    const asset = await installer.resolveAsset(d, 'b12678', []);
    assert.match(asset.url, /llama-b12678-bin-ubuntu-(x64|arm64)\.tar\.gz/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds a binary nested in bin/ after extraction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-nest-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'ollama'), '#!/bin/sh\n');
    const found = findInstalledBinary(dir, 'ollama');
    assert.equal(found, path.join(dir, 'bin', 'ollama'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('XDG data directory is used on linux', () => {
    const prev = process.env.XDG_DATA_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-home-'));
    process.env.XDG_DATA_HOME = home;
    const got = defaultAppDataDir();
    assert.equal(got, path.join(home, 'black-mirror'));
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('Multi-GPU flags and legacy NVIDIA assessment', () => {
  test('new llama.cpp version line is parsed without dropping the legacy format', () => {
    const modern = LlamaCppAdapter.parseVersionOutput(
      'version: 1.0.0-dev (build 12678, commit c74c71a6f)\n',
      'version:\\s*(\\d+)\\s*\\((\\w+)\\)'
    );
    assert.equal(modern.build, '12678');
    assert.equal(modern.commit, 'c74c71a6f');
    const legacy = LlamaCppAdapter.parseVersionOutput('version: 5132 (8f3c21d)\n', 'version:\\s*(\\d+)\\s*\\((\\w+)\\)');
    assert.equal(legacy.label, 'b5132 (8f3c21d)');
  });
  test('tensor split and main gpu are passed through only when set', () => {
    const a = new LlamaCppAdapter({ id: 'llamacpp-cuda12', serverBinary: 'llama-server' }, {});
    const args = a.buildServerArgs('/m/x.gguf', {
      contextLength: 2048, gpuLayers: 20, mainGpu: 1, tensorSplit: '3,1', splitMode: 'layer', gpuDevices: 'CUDA0'
    }, { port: 8084, bind: '127.0.0.1' });
    assert.equal(args[args.indexOf('--main-gpu') + 1], '1');
    assert.equal(args[args.indexOf('--tensor-split') + 1], '3,1');
    assert.equal(args[args.indexOf('--split-mode') + 1], 'layer');
    assert.equal(args[args.indexOf('--device') + 1], 'CUDA0');
    assert.equal(args[args.indexOf('--n-gpu-layers') + 1], '20');
  });

  test('modern CUDA descriptor is unsupported on a K80-only machine', () => {
    const verdict = assessCompatibility({
      model: { invalid: false, architecture: 'llama', quant: 'Q4_K_M', sizeBytes: 1e9, isMoE: false },
      engine: { installed: true, status: 'available', statusCategory: 'experimental', displayName: 'llama.cpp (CUDA 12)', acceleration: 'gpu-cuda', family: 'llama.cpp', modernCudaMinCC: 5.0, probedCapabilities: { probed: true, kvCacheTypes: ['f16'], images: false } },
      hardware: { platform: 'linux', cuda: 'runtime-present', legacyNvidia: true, legacyNvidiaDevices: [{ name: 'Tesla K80', computeCapability: '3.7' }], vulkan: 'unknown', mixedVendors: false },
      memory: { totalBytes: 64e9, freeBytes: 32e9 },
      savedResult: null,
      requested: { accel: 'gpu-cuda', params: {} }
    });
    assert.equal(verdict.status, STATUS.UNSUPPORTED);
    assert.match(verdict.reasons.join(' '), /K80|3\.7|CUDA 11/);
  });

  test('tensor split across vendors is unsupported', () => {
    const verdict = assessCompatibility({
      model: { invalid: false, architecture: 'llama', quant: 'Q4_K_M', sizeBytes: 1e9, isMoE: false },
      engine: { installed: true, status: 'available', statusCategory: 'compatible', displayName: 'CUDA', acceleration: 'gpu-cuda', family: 'llama.cpp', modernCudaMinCC: 5.0, probedCapabilities: { probed: true, kvCacheTypes: ['f16'], images: false } },
      hardware: { platform: 'linux', cuda: 'runtime-present', legacyNvidia: false, mixedVendors: true, vulkan: 'unknown' },
      memory: { totalBytes: 64e9, freeBytes: 32e9 },
      savedResult: null,
      requested: { accel: 'gpu-cuda', params: { tensorSplit: '1,1' } }
    });
    assert.equal(verdict.status, STATUS.UNSUPPORTED);
    assert.match(verdict.reasons.join(' '), /vendor/i);
  });
});

describe('Process ownership on Linux', () => {
  test('start-time mismatch refuses ownership (PID reuse)', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 150));
    const snap = snapshotProcess(child.pid);
    assert.ok(snap && snap.startTime, 'live /proc start time recorded');
    const verdict = verifyOwnership({
      pid: child.pid, exePath: snap.exe, modelPath: null, startTime: 'not-the-real-start'
    }, snap);
    assert.equal(verdict.owned, false);
    assert.match(verdict.reason, /start time/i);
    child.kill('SIGKILL');
  });

  test('killOwnedTree stops a child and grandchild and does not touch a stranger', async () => {
    const marker = path.join(os.tmpdir(), `bm-grand-${process.pid}-${Date.now()}`);
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.argv[1], String(g.pid));
      setInterval(()=>{}, 1000);
    `, marker], { detached: true, stdio: 'ignore' });
    const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    let grand = null;
    for (let i = 0; i < 50 && !grand; i++) {
      await new Promise(r => setTimeout(r, 40));
      if (fs.existsSync(marker)) grand = parseInt(fs.readFileSync(marker, 'utf8'), 10);
    }
    assert.ok(grand > 1, 'grandchild pid recorded');
    assert.equal(isAlive(stranger.pid), true);
    const result = await killOwnedTree(parent.pid, { termWaitMs: 1500, killWaitMs: 1500 });
    assert.equal(result.confirmedDead, true, 'owned tree confirmed dead');
    assert.equal(isAlive(parent.pid), false);
    assert.equal(isAlive(grand), false);
    assert.equal(isAlive(stranger.pid), true, 'unrelated process must survive');
    stranger.kill('SIGKILL');
    fs.rmSync(marker, { force: true });
  });

  test('remote endpoints cannot be stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-remote-'));
    const ctl = new ServerController({ descriptor() { return {}; }, adapter() { return {}; } }, new Logger(path.join(dir, 'logs')), { dataDir: dir });
    const rec = ctl.addRemote({ label: 'ext', baseUrl: 'http://127.0.0.1:9' });
    await assert.rejects(() => ctl.stop(rec.id), /never stopped|not-owned|Remote/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('external listing does not require killing anything', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ext-'));
    const ctl = new ServerController({ descriptor() { return {}; } }, new Logger(path.join(dir, 'logs')), { dataDir: dir });
    const list = await ctl.listExternal();
    assert.ok(Array.isArray(list));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
