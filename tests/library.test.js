'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGguf } = require('./helpers/ggufbuilder');
const { ModelLibrary } = require('../main/models/library');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lib-' + name + '-'));
}

function makeDataDir() {
  const dir = tmpdir('data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Model library', () => {
  test('scan dir indexes models, import does not copy', async () => {
    const dataDir = makeDataDir();
    const modelsDir = tmpdir('models');
    fs.writeFileSync(path.join(modelsDir, 'm1.gguf'), buildGguf({ kv: { 'general.name': ['string', 'Alpha'] } }));
    fs.writeFileSync(path.join(modelsDir, 'm2.gguf'), buildGguf({ kv: { 'general.name': ['string', 'Beta'] } }));
    // non-model file + hidden file must be skipped
    fs.writeFileSync(path.join(modelsDir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(modelsDir, '.hidden.gguf'), buildGguf());

    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    const res = await lib.refresh();
    assert.equal(res.total, 2);
    assert.equal(res.invalid, 0);
    const names = lib.list().map(m => m.name).sort();
    assert.deepEqual(names, ['Alpha', 'Beta']);

    // import-without-copy: file content byte-identical after import
    const impDir = tmpdir('imp');
    const impFile = path.join(impDir, 'imported.gguf');
    const before = fs.readFileSync(path.join(modelsDir, 'm1.gguf'));
    fs.writeFileSync(impFile, before);
    const imported = lib.importFile(impFile);
    assert.equal(imported.name, 'Alpha');
    assert.deepEqual(fs.readFileSync(impFile), before);
    assert.equal(lib.list().length, 3);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
    fs.rmSync(impDir, { recursive: true, force: true });
  });

  test('invalid GGUF is listed with error, app stays usable', async () => {
    const dataDir = makeDataDir();
    const modelsDir = tmpdir('models');
    fs.writeFileSync(path.join(modelsDir, 'good.gguf'), buildGguf());
    fs.writeFileSync(path.join(modelsDir, 'corrupt.gguf'), Buffer.from('garbage that is not a model at all'.repeat(10)));
    fs.writeFileSync(path.join(modelsDir, 'half.gguf'), buildGguf().subarray(0, 50));

    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    const res = await lib.refresh();
    assert.equal(res.total, 3);
    assert.equal(res.invalid, 2);
    const bad = lib.list().filter(m => m.invalid);
    for (const m of bad) {
      assert.ok(m.error && m.error.length > 3, 'has a readable error');
    }
    const good = lib.list({ onlyValid: true });
    assert.equal(good.length, 1);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });

  test('refresh picks up new files and drops vanished ones', async () => {
    const dataDir = makeDataDir();
    const modelsDir = tmpdir('models');
    const a = path.join(modelsDir, 'a.gguf');
    const b = path.join(modelsDir, 'b.gguf');
    fs.writeFileSync(a, buildGguf({ kv: { 'general.name': ['string', 'A'] } }));
    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    await lib.refresh();
    fs.writeFileSync(b, buildGguf({ kv: { 'general.name': ['string', 'B'] } }));
    const r2 = await lib.refresh();
    assert.equal(r2.added, 1);
    assert.equal(r2.total, 2);
    fs.unlinkSync(a);
    const r3 = await lib.refresh();
    assert.equal(r3.total, 1);
    assert.equal(lib.list()[0].name, 'B');
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });

  test('favorites, categories and search filters', async () => {
    const dataDir = makeDataDir();
    const modelsDir = tmpdir('models');
    fs.writeFileSync(path.join(modelsDir, 'x.gguf'), buildGguf({ kv: { 'general.name': ['string', 'Xavier'] } }));
    fs.writeFileSync(path.join(modelsDir, 'y.gguf'), buildGguf({ kv: { 'general.name': ['string', 'Yoda'], 'general.architecture': ['string', 'qwen2'] } }));
    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    await lib.refresh();
    const xp = path.join(modelsDir, 'x.gguf');

    assert.equal(lib.toggleFavorite(xp), true);
    assert.equal(lib.list({ search: 'xav' })[0].favorite, true);
    assert.equal(lib.toggleFavorite(xp), false);

    lib.setCategories(xp, ['coding', 'small']);
    lib.setCategories(path.join(modelsDir, 'y.gguf'), ['coding']);
    assert.equal(lib.list({ category: 'coding' }).length, 2);
    assert.equal(lib.list({ category: 'small' }).length, 1);
    assert.equal(lib.list({ arch: 'qwen2' }).length, 1);
    assert.deepEqual(lib.listCategories().map(c => c.name).sort(), ['coding', 'small']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });

  test('per-model profiles persist and are pruned with vanished files', async () => {
    const dataDir = makeDataDir();
    const modelsDir = tmpdir('models');
    const a = path.join(modelsDir, 'a.gguf');
    fs.writeFileSync(a, buildGguf());
    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    await lib.refresh();
    lib.saveProfile(a, { contextLength: 16384, threads: 8 });
    assert.equal(lib.getProfile(a).contextLength, 16384);
    assert.equal(lib.getProfile(a).threads, 8);
    lib.deleteProfile(a);
    assert.equal(lib.getProfile(a), null);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });

  test('memory estimate via library.estimate', async () => {
    const dataDir = makeDataDir();
    const modelsDir = tmpdir('models');
    const a = path.join(modelsDir, 'a.gguf');
    fs.writeFileSync(a, buildGguf());
    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    await lib.refresh();
    const est = lib.estimate(a, { contextLength: 4096 });
    assert.ok(est.totalBytes > est.weightsBytes);
    assert.ok(est.kvBytes > 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });
});
