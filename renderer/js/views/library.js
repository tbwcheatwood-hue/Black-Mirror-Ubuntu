'use strict';
/* Model Library view. */
const LibraryView = (() => {
  const $ = id => document.getElementById(id);
  const state = { models: [], categories: [], scanDirs: [], filter: {} };
  const QUANT_ORDER = ['F32','F16','BF16','Q8_0','Q6_K','Q5_K_M','Q5_K_S','Q4_K_M','Q4_K_S','Q4_0','IQ4_XS','Q3_K_L','Q3_K_M','Q3_K_S','IQ3_M','IQ3_XS','Q2_K','IQ2_S','IQ2_XS','IQ1_S'];

  async function init() {
    $('btn-refresh-library').addEventListener('click', () => refresh(true));
    $('lib-search').addEventListener('input', BMUtil.debounce(() => { state.filter.search = $('lib-search').value; render(); }, 200));
    $('lib-arch').addEventListener('change', () => { state.filter.arch = $('lib-arch').value || undefined; render(); });
    $('lib-cat').addEventListener('change', () => { state.filter.category = $('lib-cat').value || undefined; render(); });
    $('lib-fav').addEventListener('change', () => { state.filter.favorites = $('lib-fav').checked; render(); });
    $('btn-add-scan-dir').addEventListener('click', addScanDir);
    $('btn-import-gguf').addEventListener('click', importGguf);
    await refresh(true);
  }

  async function refresh(fromUser) {
    if (fromUser) toast('Refreshing library…');
    const res = await window.Bridge.library.refresh();
    state.models = res.models || [];
    state.categories = await window.Bridge.library.categories();
    fillFilters();
    render();
    renderScanDirs();
    if (fromUser) toast(`Library: ${res.total} models indexed${res.invalid ? `, ${res.invalid} with errors` : ''}`, 'ok');
  }

  function fillFilters() {
    const archs = [...new Set(state.models.map(m => m.architecture).filter(Boolean))].sort();
    $('lib-arch').innerHTML = '<option value="">All architectures</option>' + archs.map(a => `<option value="${BMUtil.esc(a)}">${BMUtil.esc(a)}</option>`).join('');
    $('lib-cat').innerHTML = '<option value="">All categories</option>' + state.categories.map(c => `<option value="${BMUtil.esc(c.name)}">${BMUtil.esc(c.name)} (${c.count})</option>`).join('');
  }

  function render() {
    const grid = $('library-grid');
    let models = state.models;
    const f = state.filter;
    if (f.search) { const s = f.search.toLowerCase(); models = models.filter(m => (m.name || '').toLowerCase().includes(s) || (m.fileName || '').toLowerCase().includes(s) || (m.architecture || '').toLowerCase().includes(s)); }
    if (f.arch) models = models.filter(m => m.architecture === f.arch);
    if (f.category) models = models.filter(m => (m.categories || []).includes(f.category));
    if (f.favorites) models = models.filter(m => m.favorite);

    $('lib-summary').textContent = `${models.length} of ${state.models.length} models`;
    grid.innerHTML = '';
    const sorted = [...models].sort((a, b) => {
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
      const qa = QUANT_ORDER.indexOf(a.quant), qb = QUANT_ORDER.indexOf(b.quant);
      if (qa !== qb && qa >= 0 && qb >= 0) return qb - qa;
      return (a.fileName || '').localeCompare(b.fileName || '');
    });
    for (const m of sorted) grid.appendChild(card(m));
    if (!sorted.length) grid.appendChild(BMUtil.el('div', { class: 'dim', text: 'No models found. Add a scan directory (Models are indexed in place — files are never copied or modified).' }));
  }

  function card(m) {
    const c = BMUtil.el('div', { class: 'model-card glass' + (m.invalid ? ' invalid' : '') + (m.favorite ? ' selected' : ''), onclick: () => showDetail(m) });
    const head = BMUtil.el('div', { class: 'model-name' }, [
      BMUtil.el('button', { class: 'fav', text: m.favorite ? '★' : '☆', title: 'Toggle favorite', onclick: async (e) => { e.stopPropagation(); await window.Bridge.library.toggleFavorite(m.path); refresh(false); } }),
      BMUtil.el('span', { text: m.name || m.fileName })
    ]);
    c.appendChild(head);
    if (m.invalid) {
      c.appendChild(BMUtil.el('div', { class: 'model-err', text: '⚠ ' + m.error }));
    } else {
      const meta = BMUtil.el('div', { class: 'model-meta' }, [
        BMUtil.el('span', { class: 'badge', text: m.architecture || '?' }),
        BMUtil.el('span', { class: 'badge badge-warn', text: m.quant || '?' }),
        BMUtil.el('span', { class: 'badge', text: BMUtil.formatBytes(m.sizeBytes) })
      ]);
      if (m.isMoE) meta.appendChild(BMUtil.el('span', { class: 'badge badge-on', text: `MoE ${m.expertCount}e` }));
      if (m.split) meta.appendChild(BMUtil.el('span', { class: 'badge', text: `split ${m.split.index}/${m.split.total}${m.splitComplete === false ? ' (incomplete)' : ''}` }));
      if (m.kind === 'mmproj') meta.appendChild(BMUtil.el('span', { class: 'badge badge-remote', text: 'mmproj projector' }));
      c.appendChild(meta);
      c.appendChild(BMUtil.el('div', { class: 'small dim', text: `ctx ${Number(m.ctxTrain || 0).toLocaleString()} · ${m.nLayers} layers · ${m.parameterSize || ''} ${(m.categories || []).join(', ')}` }));
    }
    c.appendChild(BMUtil.el('div', { class: 'small dim mono', text: m.fileName, style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }));
    return c;
  }

  async function showDetail(m) {
    const wrap = modal(`Model details — ${m.name || m.fileName}`);
    if (m.invalid) {
      wrap.appendChild(BMUtil.el('p', { class: 'model-err', text: m.error || 'Could not parse this file.' }));
      wrap.appendChild(BMUtil.el('p', { class: 'dim small', text: 'Black Mirror never modifies or deletes model files. If the file is truncated (a download that did not finish), re-download it with your usual tools.' }));
      return;
    }
    const rows = [
      ['File', m.path], ['Architecture', m.architecture], ['Quantization', m.quant],
      ['Size', m.splitTotalBytes ? `${BMUtil.formatBytes(m.splitTotalBytes)} across ${m.split.total} shards (${BMUtil.formatBytes(m.sizeBytes)} this shard)` : `${BMUtil.formatBytes(m.sizeBytes)} (${m.sizeMB} MB)`],
      ['Split shards', m.split ? `${m.split.total} · loading shard ${m.split.index}${m.splitComplete === false ? ` · MISSING: ${m.splitMissingShards.join(', ')}` : ''}` : 'single file'],
      ['Layers', m.nLayers], ['Trainable context', Number(m.ctxTrain || 0).toLocaleString()],
      ['MoE', m.isMoE ? `${m.expertCount} experts (${m.expertUsed} used/token)` : 'no'],
      ['Tokenizer', m.hasTokenizer ? (m.tokenizerModel || 'yes') : 'not embedded'],
      ['GGUF version', m.ggufVersion], ['License', m.license || '—'],
      ['Categories', (m.categories || []).join(', ') || '—']
    ];
    for (const [k, v] of rows) {
      wrap.appendChild(BMUtil.el('div', { class: 'hw-row' }, [
        BMUtil.el('span', { class: 'k', text: k }),
        BMUtil.el('span', { class: 'mono', text: String(v) })
      ]));
    }
    // memory estimate at default context
    try {
      const { estimate, verdict } = await window.Bridge.library.assess(m.path, 8192, 1);
      const box = BMUtil.el('div', { class: `assess-box assess-${verdict.level}`, style: 'margin-top:12px' }, [
        BMUtil.el('strong', { text: `Estimated load: ${BMUtil.formatBytes(estimate.totalBytes)} (weights ${BMUtil.formatBytes(estimate.weightsBytes)} + KV ${BMUtil.formatBytes(estimate.kvBytes)} + overhead)` }),
        BMUtil.el('ul', {}, verdict.notes.map(n => BMUtil.el('li', { text: n })))
      ]);
      wrap.appendChild(box);
    } catch (_) { /* preview mode without assess */ }

    // per-model profile editor
    const prof = await window.Bridge.library.getProfile(m.path);
    const profBox = BMUtil.el('div', { style: 'margin-top:14px' }, [BMUtil.el('h4', { text: 'Model profile (context override & saved settings)' })]);
    const fields = [
      ['contextLength', 'Context length', prof ? prof.contextLength : 8192],
      ['threads', 'CPU threads', prof ? prof.threads : null],
      ['gpuLayers', 'GPU layers (-ngl)', prof ? prof.gpuLayers : null]
    ];
    const grid = BMUtil.el('div', { class: 'launch-grid' });
    const inputs = {};
    for (const [key, label, val] of fields) {
      inputs[key] = BMUtil.el('input', { type: 'number', value: val ?? '' });
      grid.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: label }), inputs[key]]));
    }
    profBox.appendChild(grid);
    const btnRow = BMUtil.el('div', { style: 'display:flex;gap:8px;margin-top:10px' }, [
      BMUtil.el('button', { class: 'btn btn-primary btn-sm', text: 'Save profile', onclick: async () => {
        const patch = {};
        for (const [k] of fields) if (inputs[k].value !== '') patch[k] = Number(inputs[k].value);
        await window.Bridge.library.saveProfile(m.path, patch);
        toast('Profile saved for this model', 'ok');
      } }),
      BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'Delete profile', onclick: async () => { await window.Bridge.library.deleteProfile(m.path); toast('Profile removed'); } })
    ]);
    profBox.appendChild(btnRow);
    wrap.appendChild(profBox);
  }

  async function addScanDir() {
    let dir = null;
    if (typeof window.Bridge.pickDirectory === 'function') {
      dir = await window.Bridge.pickDirectory();
      if (!dir) return;
    } else {
      const linux = window.Bridge.platform === 'linux';
      dir = await uiPrompt('Add scan directory', {
        placeholder: linux ? '/mnt/models' : 'C:\\models',
        hint: 'Scanned recursively (up to 6 levels) for .gguf files. Files are indexed in place — never copied or modified.'
      });
      if (!dir) return;
    }
    try {
      await window.Bridge.library.addScanDir(dir);
      await refresh(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function importGguf() {
    let p = null;
    if (typeof window.Bridge.pickFile === 'function') {
      p = await window.Bridge.pickFile();
      if (!p) return;
    } else {
      const linux = window.Bridge.platform === 'linux';
      p = await uiPrompt('Import GGUF (no copy)', {
        placeholder: linux ? '/mnt/models/model.gguf' : 'D:\\llm\\model.gguf',
        hint: 'The file is registered in place; it is never copied, moved or modified.'
      });
      if (!p) return;
    }
    try {
      await window.Bridge.library.importFile(p);
      await refresh(true);
      toast('Imported (registered in place, file untouched)', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function renderScanDirs() {
    const box = $('scan-dirs');
    box.innerHTML = '';
    try {
      const dirs = await window.Bridge.library.listScanDirs ? await window.Bridge.library.listScanDirs() : [];
      for (const d of dirs) {
        box.appendChild(BMUtil.el('span', { class: 'scan-dir-chip' }, [
          BMUtil.el('span', { text: '📂 ' + d }),
          BMUtil.el('button', { text: '✕', onclick: async () => { await window.Bridge.library.removeScanDir(d); refresh(false); } })
        ]));
      }
    } catch (_) { /* not exposed in mock */ }
  }

  return { init, refresh };
})();
