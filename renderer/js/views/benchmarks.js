'use strict';
/* Benchmark laboratory view. */
const BenchmarksView = (() => {
  const $ = id => document.getElementById(id);
  const state = { engines: [], models: [], results: [], config: null };

  async function init() {
    state.config = await window.Bridge.getConfig();
    const [engines, models] = await Promise.all([
      window.Bridge.engines.status(),
      window.Bridge.library.list({ onlyValid: true })
    ]);
    // Benchmarks need a server Black Mirror starts with a fixed test model, so attach engines are left out.
    state.engines = engines.filter(e => e.status === 'available' && e.lifecycle !== 'attach');
    state.models = models;
    state.results = await window.Bridge.bench.results();
    renderForm();
    renderResults();
    window.Bridge.on('bench-progress', p => {
      $('bench-progress').textContent = p.stage === 'rep'
        ? `running rep ${p.rep}/${p.of}…`
        : p.stage === 'downloading' ? '' : p.stage;
    });
    $('btn-run-bench').addEventListener('click', runBench);
  }

  function renderForm() {
    const box = $('bench-form');
    box.innerHTML = '';
    const engineSel = BMUtil.el('select', {}, state.engines.map(e => BMUtil.el('option', { value: e.id, text: `${e.displayName}${e.version ? ' — ' + e.version.label : ''}` })));
    const modelSel = BMUtil.el('select', {}, state.models.map(m => BMUtil.el('option', { value: m.path, text: `${m.name} · ${m.quant}` })));
    const ctxInput = BMUtil.el('input', { type: 'number', value: state.config.params.contextLength });
    const threadsInput = BMUtil.el('input', { type: 'number', value: state.config.params.threads });
    const nglInput = BMUtil.el('input', { type: 'number', value: state.config.params.gpuLayers });
    const kvSel = BMUtil.el('select', {}, ['f16', 'q8_0', 'q4_0'].map(o => BMUtil.el('option', { value: o, text: o, selected: o === (state.config.params.kvCacheType || 'f16') ? '' : null })));
    const promptInput = BMUtil.el('input', { type: 'number', value: 512 });
    const genInput = BMUtil.el('input', { type: 'number', value: 128 });
    const repsInput = BMUtil.el('input', { type: 'number', value: 2, min: 1, max: 10 });
    const rows = [
      ['Inference engine', engineSel], ['Model', modelSel], ['Context length', ctxInput],
      ['CPU threads', threadsInput], ['GPU layers (-ngl)', nglInput], ['KV cache type', kvSel],
      ['Prompt tokens (processing test)', promptInput], ['Generation tokens', genInput], ['Repetitions', repsInput]
    ];
    for (const [label, input] of rows) {
      box.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: label }), input]));
    }
    box.appendChild(BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: '⤓ Export results (JSON)', onclick: exportResults }));
    state._inputs = { engineSel, modelSel, ctxInput, threadsInput, nglInput, kvSel, promptInput, genInput, repsInput };
  }

  function exportResults() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), app: 'Black Mirror v1.1.0', results: state.results }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'black-mirror-benchmarks.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Benchmark results exported', 'ok');
  }

  async function runBench() {
    const i = state._inputs;
    $('btn-run-bench').disabled = true;
    $('bench-progress').textContent = 'starting…';
    try {
      const run = await window.Bridge.bench.run({
        engineId: i.engineSel.value,
        modelPath: i.modelSel.value,
        params: { ...state.config.params, contextLength: Number(i.ctxInput.value), threads: Number(i.threadsInput.value), gpuLayers: Number(i.nglInput.value), kvCacheType: i.kvSel.value },
        port: (state.config.network.defaultPort || 8081) + 7, // dedicated bench port avoids conflicts
        promptTokens: Number(i.promptInput.value),
        genTokens: Number(i.genInput.value),
        reps: Number(i.repsInput.value),
        label: `${i.engineSel.value} @ ${i.modelSel.value.split(/[\\/]/).pop()}` +
          ` · ctx${i.ctxInput.value} · t${i.threadsInput.value} · ngl${i.nglInput.value} · ${i.kvSel.value}`
      });
      state.results = await window.Bridge.bench.results();
      renderResults();
      $('bench-progress').textContent = 'done';
      toast('Benchmark complete', 'ok');
    } catch (e) {
      $('bench-progress').textContent = '';
      toast(e.message, 'err');
    } finally {
      $('btn-run-bench').disabled = false;
    }
  }

  function renderResults() {
    const box = $('bench-results');
    box.innerHTML = '';
    if (!state.results.length) {
      box.appendChild(BMUtil.el('div', { class: 'dim', text: 'No results yet. Benchmarks run against real engines and take minutes, not seconds.' }));
      return;
    }
    for (const r of [...state.results].sort((a, b) => b.ts - a.ts)) {
      const s = r.summary || {};
      const el = BMUtil.el('div', { class: 'bench-run' });
      const head = BMUtil.el('div', { class: 'bench-run-head' }, [
        BMUtil.el('strong', { text: r.label }),
        BMUtil.el('span', { class: 'dim small', text: new Date(r.ts).toLocaleString() }),
        BMUtil.el('span', { class: 'badge', text: `${s.okReps ?? '—'}/${r.reps} reps ok` }),
        BMUtil.el('span', { class: 'spacer' }),
        BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'delete', onclick: async () => { await window.Bridge.bench.remove(r.id); state.results = await window.Bridge.bench.results(); renderResults(); } })
      ]);
      el.appendChild(head);
      el.appendChild(BMUtil.el('div', { class: 'bench-metrics' }, [
        metric('Load time', s.loadMs != null ? (s.loadMs / 1000).toFixed(2) + ' s' : '—'),
        metric('Time to first token', s.ttftMs != null ? (s.ttftMs / 1000).toFixed(2) + ' s' : '—'),
        metric('Prompt t/s', s.promptTps != null ? s.promptTps.toFixed(1) : '—'),
        metric('Generation t/s', s.genTps != null ? s.genTps.toFixed(1) : '—'),
        metric('Total response', s.totalMs != null ? (s.totalMs / 1000).toFixed(2) + ' s' : '—'),
        metric('Peak memory', s.peakRss ? BMUtil.formatBytes(s.peakRss) : '—')
      ]));
      el.appendChild(BMUtil.el('div', { class: 'dim small mono', style: 'margin-top:8px', text: `${r.engineId}${r.engineTag ? '@' + r.engineTag : ''} · ctx ${r.params.contextLength} · ${r.environment.cpuModel} · ${r.environment.totalMemGB} GB RAM` }));
      box.appendChild(el);
    }
  }

  function metric(label, value) {
    return BMUtil.el('div', { class: 'bench-metric' }, [
      BMUtil.el('div', { class: 'v', text: value }),
      BMUtil.el('div', { class: 'k', text: label })
    ]);
  }

  return { init };
})();
