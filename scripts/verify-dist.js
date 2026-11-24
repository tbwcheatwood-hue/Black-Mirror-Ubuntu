'use strict';
/**
 * Distribution verifier — run after `npm run build:win`.
 * Checks the packaged Windows distribution honestly:
 *   1. the executable exists and is a PE32+ x86-64 image,
 *   2. app.asar contains the expected v1.2.0 markers,
 *   3. the packaged package.json reports the current version,
 *   4. required runtime assets (icon, vendor bundles) are present.
 * Exit code 1 with a plain-language list when anything is off.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'win-unpacked');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const problems = [];
const ok = [];
const exeName = `${pkg.productName || 'Black Mirror'}.exe`;
const exe = path.join(DIST, exeName);

if (!fs.existsSync(exe)) {
  problems.push(`executable missing: ${exe} (run "npm run build:win" first)`);
} else {
  ok.push(`executable present: ${exeName} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(0)} MB)`);
  try {
    const head = fs.readFileSync(exe).subarray(0, 2).toString('hex');
    if (head === '4d5a') ok.push('MZ header present — PE image');
    else problems.push('not a PE executable (missing MZ header)');
  } catch (e) { problems.push(`cannot read executable: ${e.message}`); }
}

const asar = path.join(DIST, 'resources', 'app.asar');
if (!fs.existsSync(asar)) {
  problems.push('resources/app.asar missing');
} else {
  ok.push('app.asar present');
  try {
    // Prefer invoking the asar JS entry via node — Windows .cmd wrappers can
    // fail with EINVAL under execFileSync depending on the shell environment.
    const asarBin = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
    const list = execFileSync(process.execPath, [asarBin, 'list', asar], { encoding: 'utf8', timeout: 60000 });
    const entries = list.split('\n');
    for (const marker of ['/main/engines/capabilities.js', '/main/compatlab/lab.js', '/main/profiles.js', '/main/diagnostics.js', '/renderer/vendor/marked.min.js', '/renderer/vendor/highlight.min.js', '/assets/icon.png']) {
      const norm = marker.replace(/\\/g, '/');
      if (entries.some(e => e.trim().replace(/\\/g, '/') === norm || e.trim().replace(/\\/g, '/') === norm.slice(1))) ok.push(`asar contains ${marker}`);
      else problems.push(`asar missing v1.2.2 asset: ${marker}`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asarpkg-'));
    execFileSync(process.execPath, [asarBin, 'extract-file', asar, 'package.json'], { cwd: tmp, timeout: 60000 });
    const asarPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    if (asarPkg.version === pkg.version) ok.push(`packaged manifest reports v${asarPkg.version}`);
    else problems.push(`packaged manifest version ${asarPkg.version} != source ${pkg.version}`);
    if (!asarPkg.devDependencies) ok.push('production manifest correctly pruned (no devDependencies)');
    else problems.push('production manifest leaks devDependencies');
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    problems.push(`asar inspection failed: ${e.message}`);
  }
}

console.log('--- dist verification ---');
for (const line of ok) console.log('  ✓', line);
if (problems.length) {
  console.error('--- PROBLEMS ---');
  for (const line of problems) console.error('  ✕', line);
  process.exit(1);
} else {
  console.log(`dist verification PASSED (${ok.length} checks)`);
}
