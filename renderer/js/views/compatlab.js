/* Compatibility Lab — model/engine inspection, honest compatibility
 * assessment and manually initiated staged verification tests. */
const CompatLabView = (() => {
  const $ = id => document.getElementById(id);
    const state = { models: [], engines: [], results: [], _timer: null };

  const STATUS_STYLE = {
    'verified-compatible': ['badge badge-on', 'VERIFIED COMPATIBLE'],
    'likely-compatible': ['badge badge-on', 'LIKELY COMPATIBLE'],
    'experimental': ['badge badge-warn', 'EXPERIMENTAL'],
    'insufficient-information': ['badge', 'INSUFFICIENT INFORMATION'],
    'unsupported': ['badge badge-err', 'UNSUPPORTED'],
    'previously-failed': ['badge badge-err', 'PREVIOUSLY FAILED']
  };

  async function init() {
    await reload();
    window.Bridge.on('lab-progress', onProgress);
    $('lab-run-test').addEventListener('click', runStagedTest);
    $('lab-assess').addEventListener('click', assess);
    $('lab-model').addEventListener('change', renderModelInspection);
    $('lab-engine').addEventListener('change', renderEngineInspection);
    $('lab-check-update').addEventListener('click', checkUpdate);
    $('lab-export-results').addEventListener('click', exportResults);
  }

  async function reload() {
    const [models, engines, results] = await Promise.all([
      window.Bridge.library.list({ onlyValid: true }),
      window.Bridge.engines.status(),
      window.Bridge.lab.results()
    ]);
    state.models = models;
    state.engines = engines;
    state.results = results;
    fillSelects();
    renderModelInspection();
    renderEngineInspection();
    renderResults();
  }

  function fillSelects() {
    const ms = $('lab-model');
    ms.innerHTML = '';
    for (const m of state.models) {
      ms.appendChild(BMUtil.el('option', { value: m.path, text: `${m.name} · ${m.quant || '?'}${m.split ? ' (split)' : ''}` }));
    }
    const es = $('lab-engine');
    es.innerHTML = '';
    // The lab launches a GGUF through an engine binary; attach engines run their own server.
    for (const e of state.engines.filter(x => x.lifecycle !== 'attach')) {
      es.appendChild(BMUtil.el('option', { value: e.id, text: `${e.displayName}${e.installed ? ' — ' + (e.version ? e.version.label : 'installed') : ' (not installed)'}` }));
    }
    const as = $('lab-accel');
    as.innerHTML = '';
    const accel = $('lab-engine').value && state.engines.find(e => e.id === $('lab-engine').value)?.acceleration || 'cpu';
    for (const a of ['cpu', 'gpu-vulkan', 'gpu-sycl']) {
      as.appendChild(BMUtil.el('option', { value: a, text: a, selected: a === accel ? '' : null }));
    }
  }

  /* ---------- model inspection: confirmed vs estimated vs unknown ---------- */
  function renderModelInspection() {
    const box = $('lab-model-inspect');
    const m = state.models.find(x => x.path === $('lab-model').value);
    box.innerHTML = '';
    if (!m) { box.appendChild(BMUtil.el('div', { class: 'dim small', text: 'Select a model to inspect its metadata.' })); return; }
    const row = (label, value, kind) => BMUtil.el('div', { class: 'inspect-row' }, [
      BMUtil.el('span', { class: 'dim', text: label }),
      BMUtil.el('span', { class: 'mono', text: String(value) }),
      kind ? BMUtil.el('span', { class: `badge ${kind === 'confirmed' ? 'badge-on' : ''}`, style: 'font-size:9px', text: kind.toUpperCase() }) : null
    ]);
    const est = (() => { try { return window.BridgePreview ? null : null; } catch (_) { return null; } })();
    const rows = [
      row('Architecture', m.architecture || 'unknown', m.architecture ? 'confirmed' : 'unknown'),
      row('Quantization', m.quant || 'unknown', m.quant ? 'confirmed' : 'unknown'),
      row('Parameter count', m.parameters || (m.paramCountEstimate ? '~' + (m.paramCountEstimate / 1e9).toFixed(1) + 'B (estimated from size)' : 'unknown'), m.parameters ? 'confirmed' : 'unknown'),
      row('Type', m.isMoE ? `MoE — ${m.expertCount} experts, ${m.expertUsed} active/token` : 'Dense', m.isMoE !== undefined ? 'confirmed' : 'unknown'),
      row('Model size', m.splitTotalBytes ? `${BMUtil.formatBytes(m.splitTotalBytes)} across ${m.split.total} shards` : BMUtil.formatBytes(m.sizeBytes), 'confirmed'),
      row('Split status', m.split ? (m.splitComplete === false ? `INCOMPLETE — missing shard(s) ${m.splitMissingShards.join(', ')}` : `complete (${m.split.total} shards)`) : 'single file', 'confirmed'),
      row('Native context', m.ctxTrain ? m.ctxTrain.toLocaleString() + ' tokens' : 'unknown', m.ctxTrain ? 'confirmed' : 'unknown'),
      row('Multimodal', m.kind === 'mmproj' ? 'this IS a projector file (not loadable alone)' : m.hasVision === true ? 'vision-capable (mmproj required)' : m.hasVision === false ? 'no vision tensors detected' : 'unknown', m.hasVision !== undefined || m.kind === 'mmproj' ? 'confirmed' : 'unknown'),
      row('Projector needed', m.kind === 'mmproj' ? '—' : m.hasVision ? 'select an mmproj file at launch' : 'not required', 'confirmed')
    ];
    for (const r of rows) box.appendChild(r);
    // memory estimate (clearly an estimate)
    try {
      const e = window.Bridge.library && state._lastEstimate;
      box.appendChild(BMUtil.el('div', { class: 'small dim', style: 'margin-top:6px', text: 'Memory requirements are ESTIMATES (weights ±2%, KV ±5%, compute allowance ±30%) — see the assessment panel and the pre-load warnings.' }));
    } catch (_) { /* ignore */ }
  }

  /* ---------- engine inspection from the probed binary ---------- */
  function renderEngineInspection() {
    const box = $('lab-engine-inspect');
    const e = state.engines.find(x => x.id === $('lab-engine').value);
    box.innerHTML = '';
    if (!e) { box.appendChild(BMUtil.el('div', { class: 'dim small', text: 'Select an engine.' })); return; }
    const row = (label, value, ok) => BMUtil.el('div', { class: 'inspect-row' }, [
      BMUtil.el('span', { class: 'dim', text: label }),
      BMUtil.el('span', { class: 'mono', text: String(value) }),
      ok === true ? BMUtil.el('span', { class: 'badge badge-on', style: 'font-size:9px', text: 'PROBED' })
        : ok === false ? BMUtil.el('span', { class: 'badge badge-err', style: 'font-size:9px', text: 'MISSING' }) : null
    ]);
    const pc = e.probedCapabilities;
    const hf = e.probedHelpFlags || {};
    const sup = Object.entries(hf).filter(([, v]) => v).map(([k]) => k);
    const rows = [
      row('Name', e.displayName),
      row('Installed version', e.version ? e.version.label : (e.installed ? 'installed (probe failed)' : 'not installed'), e.version ? true : e.installed ? false : null),
      row('Executable', e.executable || (e.customPath ? e.customPath + ' (custom, missing!)' : '—'), e.executable ? true : e.installed ? false : null),
      row('Acceleration', e.acceleration),
      row('Supported launch args (probed)', sup.length ? sup.join(', ') : pc && pc.probed ? 'none advertised' : 'not probed', pc && pc.probed ? true : null),
      row('Detected devices', pc && pc.devices && pc.devices.length ? pc.devices.map(d => d.description).join('; ') : 'none reported by the binary', pc && pc.probed ? true : null),
      row('KV cache formats', pc && pc.kvCacheTypes ? pc.kvCacheTypes.join(' / ') : 'unknown', pc && pc.kvCacheTypes ? true : null),
      row('Flash attention', hf.flashAttention ? 'supported' : pc && pc.probed ? 'not advertised' : 'unknown'),
      row('CPU MoE offload', hf.cpuMoeLayers ? 'supported' : pc && pc.probed ? 'not advertised' : 'unknown'),
      row('Multimodal projector', hf.mmproj ? 'supported (--mmproj)' : pc && pc.probed ? 'not advertised' : 'unknown'),
      row('Known limitations', e.statusReason || pc && pc.note || 'none recorded')
    ];
    for (const r of rows) box.appendChild(r);
  }

  async function checkUpdate() {
    const id = $('lab-engine').value;
    const btn = $('lab-check-update');
    btn.disabled = true; btn.textContent = '⟳ Checking…';
    try {
      const r = await window.Bridge.enginesExtra.checkUpdate(id);
      if (r.updateAvailable) toast(`Newer release available: ${r.latestTag} (installed: ${r.installedTag}). Update from Inference Engines — the current install stays active until the new one validates.`, 'ok', 6000);
      else toast(r.reason === 'not installed' ? 'Engine not installed.' : `Up to date (${r.installedTag}) — latest discovered: ${r.latestTag || 'n/a'}.`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = '⇅ Check for newer release';
  }

  /* ---------- compatibility assessment ---------- */
  async function assess() {
    const modelPath = $('lab-model').value;
    const engineId = $('lab-engine').value;
    const box = $('lab-assessment');
    box.innerHTML = '';
    box.appendChild(BMUtil.el('div', { class: 'dim small', text: 'Assessing…' }));
    try {
      const r = await window.Bridge.lab.assess({
        modelPath, engineId,
        accel: $('lab-accel').value,
        profileKey: 'manual',
        params: { contextLength: Number($('lab-ctx').value) || 8192, kvCacheType: $('lab-kv').value, flashAttention: $('lab-fa').checked, cpuMoeLayers: Number($('lab-moe').value) || 0 }
      });
      box.innerHTML = '';
      const [cls, label] = STATUS_STYLE[r.status] || ['badge', r.status];
      box.appendChild(BMUtil.el('div', { class: 'lab-verdict', style: 'display:flex;gap:10px;align-items:center' }, [
        BMUtil.el('span', { class: cls, style: 'font-size:12px', text: label })
      ]));
      const ul = BMUtil.el('ul', { class: 'small', style: 'margin:8px 0 0 18px' });
      for (const reason of r.reasons || ['Static analysis found no blockers — but only a staged test proves real compatibility.']) ul.appendChild(BMUtil.el('li', { text: reason }));
      box.appendChild(ul);
      const checks = BMUtil.el('div', { class: 'small', style: 'margin-top:8px' });
      for (const c of r.checks || []) {
        checks.appendChild(BMUtil.el('div', { class: 'inspect-row' }, [
          BMUtil.el('span', { class: 'dim', text: c.id }),
          BMUtil.el('span', { text: c.detail })
        ]));
      }
      box.appendChild(checks);
      if (r.savedResult) {
        box.appendChild(BMUtil.el('div', { class: 'small dim', style: 'margin-top:8px', text: `Evidence: lab test ${r.savedResult.outcome}${r.savedResult.stale ? ` (STALE — ${r.savedResult.staleReason})` : ' (current)'} at ${new Date(r.savedResult.at).toLocaleString()}` }));
      }
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(BMUtil.el('div', { class: 'model-err', text: '⚠ ' + e.message }));
    }
  }

  /* ---------- staged manual test ---------- */
  function onProgress(p) {
    const box = $('lab-test-progress');
    const line = BMUtil.el('div', { class: `inspect-row ${p.status === 'fail' ? 'model-err' : ''}` }, [
      BMUtil.el('span', { class: 'dim mono', text: p.stage }),
      BMUtil.el('span', { text: `${p.status === 'pass' ? '✓' : p.status === 'fail' ? '✕' : '…'} ${p.detail || ''}` })
    ]);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  async function runStagedTest() {
    const modelPath = $('lab-model').value;
    const engineId = $('lab-engine').value;
    if (!modelPath) { toast('Select a model first', 'warn'); return; }
    if (!(await uiConfirm('Run compatibility test', 'This will briefly load the selected model in a dedicated test server (small context, then unload). Manual action only — nothing runs automatically. Continue?', { danger: false, confirmLabel: 'Run test' }))) return;
    $('lab-test-progress').innerHTML = '';
    const btn = $('lab-run-test');
    btn.disabled = true; btn.textContent = '⟳ Testing…';
    try {
      const result = await window.Bridge.lab.runTest({
        modelPath, engineId,
        engineTag: (state.engines.find(e => e.id === engineId) || {}).activeTag || null,
        accel: $('lab-accel').value,
        profileKey: 'manual',
        modelMtimeMs: (state.models.find(m => m.path === modelPath) || {}).mtimeMs,
        modelDisplayName: 'compat-lab',
        port: 8099,
        params: { contextLength: Math.min(Number($('lab-ctx').value) || 2048, 2048), threads: 2, kvCacheType: $('lab-kv').value, flashAttention: $('lab-fa').checked, cpuMoeLayers: Number($('lab-moe').value) || 0 }
      });
      const ok = result.stages.filter(s => s.ok).length;
      toast(`Compatibility test ${result.outcome.toUpperCase()} — ${ok}/${result.stages.length} stages passed`, result.outcome === 'pass' ? 'ok' : 'err', 6000);
      await reload();
      await assess();
    } catch (e) {
      toast(e.message, 'err');
    }
    btn.disabled = false; btn.textContent = '▶ Run staged compatibility test';
  }

  function renderResults() {
    const box = $('lab-results');
    box.innerHTML = '';
    if (!state.results.length) { box.appendChild(BMUtil.el('div', { class: 'dim small', text: 'No saved compatibility tests yet.' })); return; }
    const tbl = BMUtil.el('table', { class: 'data-table' });
    tbl.appendChild(BMUtil.el('thead', {}, [BMUtil.el('tr', {}, ['Model', 'Engine', 'Version', 'Outcome', 'Freshness', 'When'].map(h => BMUtil.el('th', { text: h })))]));
    const tb = BMUtil.el('tbody');
    for (const r of state.results.slice(0, 30)) {
      tb.appendChild(BMUtil.el('tr', {}, [
        BMUtil.el('td', { class: 'mono small', text: r.modelPath.split(/[\\/]/).pop() }),
        BMUtil.el('td', { text: r.engineId }),
        BMUtil.el('td', { class: 'mono small', text: r.engineTag || '—' }),
        BMUtil.el('td', {}, [BMUtil.el('span', { class: r.outcome === 'pass' ? 'badge badge-on' : 'badge badge-err', text: r.outcome })]),
        BMUtil.el('td', {}, [BMUtil.el('span', { class: r.stale ? 'badge badge-warn' : 'badge badge-on', text: r.stale ? 'stale' : 'current', title: r.staleReason || '' })]),
        BMUtil.el('td', { class: 'small dim', text: new Date(r.at).toLocaleString() })
      ]));
    }
    tbl.appendChild(tb);
    box.appendChild(tbl);
  }

  function exportResults() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), app: 'Black Mirror v1.2.2', results: state.results }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'black-mirror-compat-results.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Compatibility results exported', 'ok');
  }

  return { init, reload };
})();
