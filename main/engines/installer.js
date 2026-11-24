'use strict';
/**
 * Engine installer: download official release artifacts, extract into the
 * Black Mirror engines directory (isolated from system installs), register
 * versions, switch between them, update and roll back.
 *
 * Extraction: PowerShell Expand-Archive on Windows, `unzip` elsewhere.
 * Download: plain fetch with progress events. Injected fetchImpl makes the
 * whole flow testable against a local server.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EngineError } = require('./adapters');
const { isWindows, findInstalledBinary } = require('../core/util');

class EngineInstaller {
  constructor(registry, logger, opts = {}) {
    this.registry = registry;
    this.logger = logger;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.maxZipBytes = opts.maxZipBytes || 3 * 1024 * 1024 * 1024; // sanity cap
    this.onProgress = opts.onProgress || (() => {});
  }

  /**
   * Resolve the tag to install. Strategy chain (each step is optional and
   * failures fall through — no GitHub API credentials required):
   *   1. explicit tag argument
   *   2. stableTagPointer — text pointer file (llama.cpp nightly-tag.txt)
   *      or GitHub API latest (may be rate limited)
   *   3. releases page scrape — highest b<number> tag
   *   4. expanded_assets scrape — asset names of the newest listed release
   */
  async resolveTag(descriptor, explicitTag) {
    if (explicitTag) return { tag: explicitTag, via: 'explicit' };
    const inst = descriptor.install;
    const attempts = [];
    // 2. stable pointer
    try {
      if (inst.stableTagPointer && inst.stableTagPointer.includes('nightly-tag')) {
        const res = await this.fetchImpl(inst.stableTagPointer, { timeout: 15000 });
        if (res.ok) {
          const txt = (await res.text()).trim();
          if (/^[a-z][\w.-]*\d+$/i.test(txt)) return { tag: txt, via: 'stable-pointer' };
          attempts.push('stable-pointer: unparseable content');
        } else attempts.push(`stable-pointer: HTTP ${res.status}`);
      } else if (inst.stableTagPointer && inst.stableTagPointer.includes('api.github.com')) {
        const res = await this.fetchImpl(inst.stableTagPointer, { timeout: 15000, headers: { 'User-Agent': 'BlackMirror' } });
        if (res.ok) {
          const j = await res.json();
          if (j.tag_name) return { tag: j.tag_name, via: 'github-api-latest' };
        } else attempts.push(`github-api: HTTP ${res.status}`);
      }
    } catch (e) {
      attempts.push(`stable pointer: ${e.message}`);
      if (this.logger) this.logger.warn('installer', `stable tag pointer failed: ${e.message}`);
    }
    // 3./4. page scrapes
    try {
      const tags = await this._scrapeReleaseTags(inst.repo);
      const bTags = tags.filter(t => /b\d+$/i.test(t))
        .map(t => ({ t, n: parseInt(t.match(/b(\d+)$/i)[1], 10) }))
        .sort((a, b) => b.n - a.n);
      if (bTags.length) return { tag: bTags[0].t, via: 'releases-page', recentTags: bTags.slice(0, 6).map(x => x.t) };
      attempts.push('releases page: no b-tags');
      if (inst.tagStyle === 'semver') {
        const sem = tags.filter(t => /^v?\d+\.\d+\.\d+/.test(t));
        sem.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        if (sem.length) return { tag: sem[0], via: 'releases-page-semver', recentTags: sem.slice(0, 6) };
        attempts.push('releases page: no semver tags');
      }
    } catch (e) {
      attempts.push(`releases page: ${e.message}`);
    }
    throw new EngineError(
      `Could not resolve a version tag for ${descriptor.id} (tried: ${attempts.join('; ')}). Install manually and set a custom executable path.`,
      'tag');
  }

  /** Scrape tag links from the releases listing page. */
  async _scrapeReleaseTags(repo) {
    const res = await this.fetchImpl(`https://github.com/${repo}/releases`, {
      timeout: 20000,
      headers: { 'User-Agent': 'BlackMirror', 'Accept': 'text/html' }
    });
    if (!res.ok) throw new EngineError(`GitHub unreachable (${res.status})`, 'network');
    const html = await res.text();
    return [...html.matchAll(new RegExp(`/${repo}/releases/tag/([\\w.-]+)`, 'gi'))].map(m => m[1]);
  }

  /**
   * Resolve the concrete download asset: verify the templated URL exists
   * (HEAD) before downloading; on 404 walk recent tags (newest first, up to
   * 5) so a renamed/unbuilt asset never dead-ends the install. Never
   * hardcodes versions or asset names beyond the descriptor templates.
   */
  async resolveAsset(descriptor, tag, recentTags = []) {
    const inst = descriptor.install;
    const tryTags = [tag, ...recentTags.filter(t => t !== tag)].slice(0, 6);
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platformKey = `${process.platform}-${arch}`;
    let templates = [];
    const fromMap = inst.assets && inst.assets[platformKey];
    if (Array.isArray(fromMap)) templates = fromMap.filter(Boolean);
    else if (fromMap) templates = [fromMap];
    else if (process.arch === 'arm64' && inst.assetTemplateArm64) templates = [inst.assetTemplateArm64];
    else if (inst.assetTemplate) templates = [inst.assetTemplate];
    if (!templates.length) throw new EngineError(`No install asset template for ${process.platform}/${arch}`, 'asset');
    const fill = (tpl, t) => String(tpl).replaceAll('{tag}', t).replaceAll('{version}', String(t).replace(/^v/, ''));
    for (const template of templates) {
      for (const t of tryTags) {
        const url = `https://github.com/${inst.repo}/releases/download/${t}/${fill(template, t)}`;
        try {
          const head = await this.fetchImpl(url, { method: 'HEAD', timeout: 15000 });
          if (head.ok || head.status === 302 || head.status === 200) {
            if (t !== tag && this.logger) this.logger.warn('installer', `asset for ${tag} missing; using ${t} instead`);
            return { url, tag: t, via: `asset-verify(${platformKey})` };
          }
        } catch (_) { /* try next */ }
      }
    }
    return { url: `https://github.com/${inst.repo}/releases/download/${tag}/${fill(templates[0], tag)}`, tag, via: 'unverified' };
  }

  /** Download a URL to a file with progress reporting. */
  async download(url, destFile) {
    const res = await this.fetchImpl(url, { timeout: 0 });
    if (!res.ok) throw new EngineError(`Download failed (${res.status}) for ${url}`, 'network');
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    const out = fs.createWriteStream(destFile);
    const reader = res.body.getReader ? res.body.getReader() : null;
    await new Promise((resolve, reject) => {
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > this.maxZipBytes) throw new EngineError('Download exceeded size cap', 'size');
            if (!out.write(Buffer.from(value))) {
              await new Promise(r => out.once('drain', r));
            }
            this.onProgress({ url, received, total, ratio: total ? received / total : null });
          }
          out.end(resolve);
        } catch (e) {
          out.end();
          reject(e);
        }
      };
      if (reader) pump();
      else {
        // Node 18+ fetch gives a web stream; body is already a ReadableStream.
        require('stream').Readable.fromWeb(res.body).pipe(out)
          .on('error', reject)
          .on('finish', resolve);
      }
    });
    return { bytes: received };
  }

  /** Extract a release archive (zip or tar.gz) into destDir. */
  async extractZip(archiveFile, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const isTarGz = archiveFile.toLowerCase().endsWith('.tar.gz') || archiveFile.toLowerCase().endsWith('.tgz');
    if (isWindows() && !isTarGz) {
      await new Promise((resolve, reject) => {
        const p = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${archiveFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
        ], { windowsHide: true });
        p.on('exit', c => c === 0 ? resolve() : reject(new EngineError(`Expand-Archive exited ${c}`, 'extract')));
        p.on('error', reject);
      });
    } else if (isTarGz) {
      const r = spawnSync('tar', ['--no-same-owner', '-xzf', archiveFile, '-C', destDir], { timeout: 15 * 60 * 1000 });
      if (r.status !== 0) throw new EngineError(`tar extraction failed: ${r.stderr}`, 'extract');
    } else {
      const r = spawnSync('unzip', ['-q', '-o', archiveFile, '-d', destDir], { timeout: 10 * 60 * 1000 });
      if (r.status !== 0) throw new EngineError(`unzip failed: ${r.stderr}`, 'extract');
    }
    return destDir;
  }

  /**
   * Install (or update) an engine. If the resolved tag is already installed,
   * this is a no-op unless force=true. Never touches system installations of
   * Ollama/llama.cpp — everything lands under <dataDir>/engines/<id>/<tag>.
   */
  async install(engineId, { tag } = {}) {
    const d = this._platformDescriptor(this.registry.descriptor(engineId));
    const resolved = await this.resolveTag(d, tag);
    const resolvedTag = resolved.tag;
    const existing = this.registry.state(engineId).versions.find(v => v.tag === resolvedTag);
    if (existing && !d.install.url) {
      if (this.logger) this.logger.info('installer', `${engineId} ${resolvedTag} already installed`);
      return { tag: resolvedTag, via: resolved.via, dir: existing.dir, alreadyInstalled: true };
    }
    const dir = path.join(this.registry.enginesDir, engineId, resolvedTag);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    if (d.install.type === 'github-release-zip') {
      const asset = await this.resolveAsset(d, resolvedTag, resolved.recentTags || []);
      // Disk-space guard: refuse to start a download we cannot finish.
      await this._assertDiskSpace(this.registry.enginesDir, 600 * 1024 * 1024);
      // STAGING: extract into .staging-<tag> and validate BEFORE anything
      // touches an existing working install. Failed updates can never
      // destroy the previously working engine version.
      const staging = path.join(this.registry.enginesDir, engineId, `.staging-${asset.tag}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      const tmp = path.join(this.registry.enginesDir, engineId, archiveName(asset.url, asset.tag));
      this.onProgress({ engineId, stage: 'downloading', url: asset.url, via: asset.via });
      try {
        await this.download(asset.url, tmp);
        await this._assertDiskSpace(this.registry.enginesDir, Math.max(600 * 1024 * 1024, fs.statSync(tmp).size * 3));
        // Official checksum verification when the descriptor provides one.
        await this._verifyChecksum(d, asset, tmp);
        this.onProgress({ engineId, stage: 'extracting', url: asset.url });
        await this.extractZip(tmp, staging);
        // Validate the staged tree before it becomes an install.
        this._validateStaged(d, staging);
        fs.rmSync(tmp, { force: true });
      } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      // The verified asset may have walked to a different tag than the
      // pointer suggested — install under the tag actually shipped.
      const finalTag = asset.tag;
      const finalDir = path.join(this.registry.enginesDir, engineId, finalTag);
      const existingFinal = fs.existsSync(finalDir);
      if (existingFinal) {
        // Re-install/update: keep the old tree until the new one is in place.
        fs.renameSync(finalDir, `${finalDir}.old-${Date.now()}`);
      }
      if (staging !== finalDir) fs.renameSync(staging, finalDir);
      if (finalDir !== dir) fs.rmSync(dir, { recursive: true, force: true });
      this.registry.registerVersion(engineId, finalTag, finalDir, { activate: true });
      if (this.logger) this.logger.info('installer', `${engineId} ${finalTag} installed+validated at ${finalDir} (tag via ${resolved.via}, asset via ${asset.via})`);
      return { tag: finalTag, dir: finalDir, via: { tag: resolved.via, asset: asset.via }, alreadyInstalled: false, validated: true };
    } else if (d.install.type === 'download-run-installer') {
      // e.g. Ollama — download the official installer; user runs it (or we
      // launch it on Windows). We do NOT modify their existing installs.
      const url = d.install.url;
      const tmp = path.join(this.registry.enginesDir, engineId, 'installer.exe');
      this.onProgress({ engineId, stage: 'downloading', url });
      await this.download(url, tmp);
      if (isWindows()) {
        this.onProgress({ engineId, stage: 'launching-installer' });
        const { spawn: sp } = require('child_process');
        sp(tmp, [], { detached: true, stdio: 'ignore' }).unref();
        this.registry.registerVersion(engineId, 'system', dir, { activate: false, label: 'installer launched' });
        return { tag: resolvedTag, dir: tmp, launchedInstaller: true };
      }
      return { tag: resolvedTag, dir: tmp, needsManualInstall: true };
    }

    this.registry.registerVersion(engineId, resolvedTag, dir, { activate: true });
    if (this.logger) this.logger.info('installer', `${engineId} ${resolvedTag} installed at ${dir}`);
    return { tag: resolvedTag, dir, via: { tag: resolved.via }, alreadyInstalled: false };
  }

  /** Refuse to fill a volume we cannot fit the work in. Uses fs.statfs. */
  async _assertDiskSpace(dirPath, neededBytes) {
    try {
      const st = fs.statfsSync ? fs.statfsSync(dirPath) : null;
      if (!st) return; // platform without statfs — skip honestly
      const free = st.bavail * st.bsize;
      if (free < neededBytes) {
        throw new EngineError(`Insufficient disk space: ${(free / 1024 ** 3).toFixed(1)} GB free, operation needs at least ${(neededBytes / 1024 ** 3).toFixed(1)} GB.`, 'disk-space');
      }
    } catch (e) {
      if (e.code === 'disk-space') throw e;
      // statfs unavailable/failed — do not block, but note it
      if (this.logger) this.logger.warn('installer', `disk space check unavailable: ${e.message}`);
    }
  }

  /**
   * Verify an official checksum when the descriptor provides a source.
   * (llama.cpp does not publish per-asset checksums; Ollama installers are
   * verified by the OS installer. The mechanism exists for descriptors that
   * do — absence of a source is reported, never silently skipped.)
   */
  async _verifyChecksum(descriptor, asset, archiveFile) {
    const inst = descriptor.install;
    if (!inst.checksumTemplate) {
      if (this.logger) this.logger.info('installer', `no official checksum published for ${descriptor.id} — archive integrity enforced by extraction validation`);
      return { verified: false, reason: 'no official checksum source in descriptor' };
    }
    const url = inst.checksumTemplate.replace('{tag}', asset.tag);
    const res = await this.fetchImpl(url, { timeout: 20000 });
    if (!res.ok) throw new EngineError(`Checksum source unreachable (HTTP ${res.status}) — refusing to install without verification.`, 'checksum');
    const text = await res.text();
    const name = asset.url.split('/').pop();
    const line = text.split(/\r?\n/).find(l => l.includes(name));
    if (!line) throw new EngineError(`Checksum list does not contain ${name} — refusing install.`, 'checksum');
    const expected = line.trim().split(/\s+/)[0].toLowerCase();
    const actual = require('crypto').createHash('sha256').update(fs.readFileSync(archiveFile)).digest('hex');
    if (actual !== expected) throw new EngineError(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}. Archive corrupted or tampered — nothing was installed.`, 'checksum');
    return { verified: true, sha256: actual };
  }

  /**
   * Validate a staged engine tree BEFORE activation: the expected server
   * binary must exist and be executable-looking. Catches wrong-arch assets,
   * incomplete downloads and failed extractions before anything is replaced.
   */
  /** Apply per-OS install overrides without mutating the shared descriptor. */
  _platformDescriptor(d) {
    const plat = d.install && d.install.platforms && d.install.platforms[process.platform];
    if (!plat) return d;
    return { ...d, serverBinary: plat.serverBinary || d.serverBinary, install: { ...d.install, ...plat } };
  }

  _validateStaged(descriptor, stagingDir) {
    const serverBinary = descriptor.serverBinary;
    if (!serverBinary) return { ok: true };
    const exeName = serverBinary + (isWindows() ? '.exe' : '');
    const found = findInstalledBinary(stagingDir, exeName);
    if (!found) {
      throw new EngineError(
        `Staged ${descriptor.id} archive does not contain the expected ${exeName} binary — wrong asset, wrong architecture, or corrupted archive. Nothing was installed; your previous version is untouched.`,
        'invalid-archive');
    }
    try { fs.chmodSync(found, 0o755); } catch (_) { /* Windows or read-only */ }
    return { ok: true, binary: found };
  }

  /** Uninstall one version (only files inside Black Mirror's engines dir). */
  uninstall(engineId, tag) {
    const st = this.registry.state(engineId);
    const v = st.versions.find(v => v.tag === tag);
    if (!v) throw new EngineError(`Version ${tag} not installed`, 'not-installed');
    // Safety: only remove inside our engines dir.
    const base = path.resolve(this.registry.enginesDir);
    const dir = path.resolve(v.dir);
    if (!dir.startsWith(base)) {
      throw new EngineError('Refusing to remove a directory outside Black Mirror engines folder', 'safety');
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return this.registry.removeVersion(engineId, tag);
  }
}

function archiveName(url, tag) {
  const base = String(url || '').split('?')[0].split('/').pop() || '';
  if (/\.(zip|tar\.gz|tgz|tar\.xz)$/i.test(base)) return base;
  return `${tag || 'engine'}.zip`;
}

module.exports = { EngineInstaller, archiveName };
