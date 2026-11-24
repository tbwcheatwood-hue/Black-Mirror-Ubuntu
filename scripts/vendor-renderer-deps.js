// Copies renderer-side UMD bundles (markdown + syntax highlighting) from
// node_modules into renderer/vendor so the renderer never needs require().
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

const jobs = [
  {
    from: path.join(root, 'node_modules', 'highlight.js', 'styles', 'github-dark.css'),
    to: path.join(vendor, 'hljs-github-dark.css')
  }
];

// highlight.js ships CJS/ESM only in v11 — build a UMD/IIFE bundle for the
// renderer with esbuild. Falls back to a warning if esbuild is unavailable.
// marked >= 16 no longer ships a prebuilt UMD bundle — build it like hljs.
function bundleMarked() {
  const to = path.join(vendor, 'marked.min.js');
  try {
    const esbuild = require('esbuild');
    // Use the ESM entry: the UMD source trips esbuild's CJS interop and
    // loses the global export (verified in isolation).
    esbuild.buildSync({
      entryPoints: [path.join(root, 'node_modules', 'marked', 'lib', 'marked.esm.js')],
      bundle: true,
      minify: true,
      format: 'iife',
      globalName: 'marked',
      target: ['chrome120'],
      outfile: to,
      logLevel: 'silent'
    });
    console.log('[vendor] bundled', path.basename(to));
  } catch (e) {
    console.warn('[vendor] marked bundle failed:', e.message);
  }
}
bundleMarked();

function bundleHljs() {
  const to = path.join(vendor, 'highlight.min.js');
  try {
    const esbuild = require('esbuild');
    esbuild.buildSync({
      entryPoints: [path.join(root, 'node_modules', 'highlight.js', 'lib', 'common.js')],
      bundle: true,
      minify: true,
      format: 'iife',
      globalName: 'hljs',
      target: ['chrome120'],
      outfile: to,
      logLevel: 'silent'
    });
    console.log('[vendor] bundled', path.basename(to));
  } catch (e) {
    console.warn('[vendor] esbuild bundle failed:', e.message);
  }
}
bundleHljs();

for (const j of jobs) {
  try {
    if (fs.existsSync(j.from)) {
      fs.copyFileSync(j.from, j.to);
      console.log('[vendor] copied', path.basename(j.to));
    } else {
      console.warn('[vendor] missing (optional):', j.from);
    }
  } catch (e) {
    console.warn('[vendor] failed for', j.from, e.message);
  }
}
