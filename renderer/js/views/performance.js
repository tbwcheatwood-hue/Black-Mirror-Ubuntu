'use strict';
/* Performance dashboard: live cards, sparkline charts, pre-load assessment. */
const PerformanceView = (() => {
  const $ = id => document.getElementById(id);
  const state = { samples: [], config: null, models: [] };
  const HISTORY = 120;

  async function init() {
    state.config = await window.Bridge.getConfig();
    state.models = await window.Bridge.library.list({ onlyValid: true });
    renderAssessForm();
    window.Bridge.on('monitor-sample', onSample);
    // pull one sample immediately (real bridge) or from the mock
    try { const s = await window.Bridge.monitorSample(); if (s) onSample(s); } catch (_) { /* preview: wait for pushed samples */ }
  }

  function onSample(s) {
    state.samples.push(s);
    if (state.samples.length > HISTORY) state.samples.shift();
    renderCards(s);
    drawChart('chart-cpu', state.samples.map(x => x.cpu.percent), 100);
    drawChart('chart-mem', state.samples.map(x => x.memory.usedPct), 100);
    renderProcesses(s);
    if (s.servers && s.servers.length) {
      $('perf-uptime').textContent = s.servers.map(x => `server up ${BMUtil.formatDuration(x.uptimeSec)}`).join(' · ');
    }
  }

  function renderCards(s) {
    const cards = [
      { label: 'CPU', value: s.cpu.percent != null ? s.cpu.percent.toFixed(1) + '%' : '—', sub: `${s.cpu.cores} threads · ${s.cpu.model}` },
      { label: 'RAM used', value: s.memory.usedPct.toFixed(1) + '%', sub: `${BMUtil.formatBytes(s.memory.totalBytes - s.memory.freeBytes)} of ${BMUtil.formatBytes(s.memory.totalBytes)} · free ${BMUtil.formatBytes(s.memory.freeBytes)}` },
      { label: 'Committed', value: s.memory.committedTotalBytes ? `${Math.round(100 * (1 - s.memory.committedFreeBytes / s.memory.committedTotalBytes))}%` : 'n/a', sub: s.memory.committedTotalBytes ? `${BMUtil.formatBytes(s.memory.committedUsedBytes ?? 0)} used of ${BMUtil.formatBytes(s.memory.committedTotalBytes)} limit` : 'not available on this platform' },
      { label: 'Pagefile', value: s.memory.pagefileAllocatedBytes ? `${Math.round(100 * (s.memory.pagefileUsedBytes || 0) / s.memory.pagefileAllocatedBytes)}%` : 'n/a', sub: s.memory.pagefileAllocatedBytes ? `${BMUtil.formatBytes(s.memory.pagefileUsedBytes || 0)} of ${BMUtil.formatBytes(s.memory.pagefileAllocatedBytes)} in use` : 'not measurable here' },
      { label: 'GPU', value: s.gpu.available && s.gpu.utilizationPercent != null ? s.gpu.utilizationPercent + '%' : 'n/a', sub: s.gpu.available ? `${s.gpu.name}` : (s.gpu.note || '').slice(0, 90) },
      { label: 'Model memory', value: s.managedProcesses.length ? BMUtil.formatBytes(s.managedProcesses.reduce((a, p) => a + p.memoryBytes, 0)) : '—', sub: s.managedProcesses.length ? `${s.managedProcesses.length} managed process${s.managedProcesses.length === 1 ? '' : 'es'}` : 'no managed inference process' },
      { label: 'System uptime', value: BMUtil.formatDuration(s.uptimeSec), sub: '' }
    ];
    $('perf-cards').innerHTML = cards.map(c => `
      <div class="perf-card glass">
        <div class="perf-label">${BMUtil.esc(c.label)}</div>
        <div class="perf-value">${BMUtil.esc(c.value)}</div>
        <div class="perf-sub">${BMUtil.esc(c.sub)}</div>
      </div>`).join('');
  }

  function drawChart(canvasId, data, max) {
    const canvas = $(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let y = 0; y <= 4; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * h / 4); ctx.lineTo(w, y * h / 4); ctx.stroke();
    }
    if (!data.length) return;
    const lastX = ((data.length - 1) / Math.max(1, HISTORY - 1)) * w;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(139,92,246,0.5)');
    grad.addColorStop(1, 'rgba(139,92,246,0.05)');
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(1, HISTORY - 1)) * w;
      const y = h - Math.min(1, (v || 0) / max) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(lastX, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  function renderProcesses(s) {
    const box = $('perf-processes');
    if (!s.managedProcesses.length) { box.innerHTML = '<div class="dim small">No managed inference processes are running.</div>'; return; }
    box.innerHTML = s.managedProcesses.map(p => `
      <div class="proc-row mono"><span class="badge badge-on">managed</span><span>pid ${p.pid}</span><span>${BMUtil.formatBytes(p.memoryBytes)} RSS</span></div>
    `).join('');
  }

  function renderAssessForm() {
    const box = $('preload-assess');
    const modelSel = BMUtil.el('select', {}, state.models.map(m => BMUtil.el('option', { value: m.path, text: `${m.name} · ${m.quant} · ${BMUtil.formatBytes(m.sizeBytes)}` })));
    const ctxInput = BMUtil.el('input', { type: 'number', value: state.config.params.contextLength, step: 512 });
    const slotsInput = BMUtil.el('input', { type: 'number', value: state.config.params.parallelSlots, min: 1 });
    const out = BMUtil.el('div', { class: 'assess-box assess-ok', style: 'margin-top:10px' });
    const run = async () => {
      try {
        const { estimate, verdict } = await window.Bridge.library.assess(modelSel.value, Number(ctxInput.value), Number(slotsInput.value));
        out.className = `assess-box assess-${verdict.level}`;
        out.innerHTML = '';
        out.appendChild(BMUtil.el('strong', { text: `${BMUtil.formatBytes(estimate.totalBytes)} estimated at load (KV ${BMUtil.formatBytes(estimate.kvBytes)} scales with context × ${slotsInput.value} slot(s)) — ${verdict.level === 'ok' ? 'comfortably fits' : 'see notes'}. This is advisory only; loading is never blocked.` }));
        if (verdict.notes.length) out.appendChild(BMUtil.el('ul', {}, verdict.notes.map(n => BMUtil.el('li', { text: n }))));
      } catch (e) {
        out.textContent = e.message;
      }
    };
    [modelSel, ctxInput, slotsInput].forEach(el => el.addEventListener('change', run));
    box.appendChild(BMUtil.el('div', { class: 'launch-grid' }, [
      BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Model' }), modelSel]),
      BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Context length' }), ctxInput]),
      BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Parallel slots' }), slotsInput])
    ]));
    box.appendChild(out);
    run();
  }

  return { init };
})();
