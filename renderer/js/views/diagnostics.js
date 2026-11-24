/* Diagnostics & Troubleshooting Center — local snapshot, plain-language
 * hints, one-click export. Nothing leaves the machine automatically. */
const DiagnosticsView = (() => {
  const $ = id => document.getElementById(id);
  
  async function init() {
    $('diag-refresh').addEventListener('click', load);
    $('diag-export').addEventListener('click', exportReport);
    await load();
  }

  async function load() {
    const box = $('diag-body');
    box.innerHTML = '<div class="dim small">Collecting snapshot…</div>';
    try {
      const d = await window.Bridge.diagnostics.snapshot();
      box.innerHTML = '';
      const section = (title, node) => {
        const wrap = BMUtil.el('div', { class: 'glass', style: 'padding:12px;margin-bottom:10px' });
        wrap.appendChild(BMUtil.el('h3', { text: title, style: 'margin:0 0 8px' }));
        wrap.appendChild(node);
        box.appendChild(wrap);
      };
      // hints first
      const hintBox = BMUtil.el('div', {});
      for (const h of d.hints || []) hintBox.appendChild(BMUtil.el('div', { class: 'small', style: 'padding:4px 0', text: '• ' + h }));
      section('Troubleshooting hints', hintBox);

      const kv = rows => { const b = BMUtil.el('div', {}); for (const [k, v] of rows) b.appendChild(BMUtil.el('div', { class: 'inspect-row' }, [BMUtil.el('span', { class: 'dim', text: k }), BMUtil.el('span', { class: 'mono small', text: String(v) })])); return b; };
      section('Application', kv([
        ['Version', d.app.version], ['Platform', `${d.app.platform} ${d.app.arch}`],
        ['Electron', d.app.electron], ['Node', d.app.node], ['Uptime', d.app.uptimeSec + ' s']
      ]));
      section('Hardware & memory', kv([
        ['CPU', (d.hardware && d.hardware.cpuModel) || (d.memorySample && d.memorySample.cpu && d.memorySample.cpu.model) || 'unknown'],
        ['RAM', d.os ? `${BMUtil.formatBytes(d.os.totalMem)} total · ${BMUtil.formatBytes(d.os.freeMem)} free` : 'unknown'],
        ['Commit headroom', d.memorySample && d.memorySample.memory ? BMUtil.formatBytes(d.memorySample.memory.committedFreeBytes) : 'n/a'],
        ['Vulkan', (d.hardware && d.hardware.vulkan) || 'unknown'],
        ['SYCL runtime', (d.hardware && d.hardware.sycl) || 'unknown']
      ]));
      const eng = BMUtil.el('table', { class: 'data-table' });
      eng.appendChild(BMUtil.el('thead', {}, [BMUtil.el('tr', {}, ['Engine', 'Installed', 'Version', 'Category', 'Probe'].map(h => BMUtil.el('th', { text: h })))]));
      const tb = BMUtil.el('tbody');
      for (const e of d.engines || []) {
        tb.appendChild(BMUtil.el('tr', {}, [
          BMUtil.el('td', { text: e.displayName }),
          BMUtil.el('td', { text: e.installed ? 'yes' : 'no' }),
          BMUtil.el('td', { class: 'mono small', text: (e.version || '—') }),
          BMUtil.el('td', { text: e.statusCategory || '—' }),
          BMUtil.el('td', { class: 'small', text: e.probedCapabilities && e.probedCapabilities.probed ? 'probed' : (e.error || 'not probed') })
        ]));
      }
      eng.appendChild(tb);
      section(`Inference engines (${(d.engines || []).length})`, eng);

      section('Model library health', kv([
        ['Models indexed', d.models ? d.models.total : '—'],
        ['Invalid files', d.models ? d.models.invalid : '—'],
        ['Incomplete splits', d.models ? d.models.incompleteSplits : '—'],
        ['Projectors (mmproj)', d.models ? d.models.mmproj : '—']
      ]));
      section('Processes & endpoints', kv([
        ['Managed servers', JSON.stringify((d.managedProcesses || []).map(p => `pid ${p.pid} ${p.status}${p.recovered ? ' (recovered)' : ''}`))],
        ['Remote endpoints', JSON.stringify((d.remotes || []).map(r => r.baseUrl))],
        ['Unverified recovered', JSON.stringify((d.unverifiedRecovered || []).map(u => `pid ${u.pid}: ${u.reason}`))],
        ['Port conflicts', JSON.stringify((d.portConflicts || []).filter(p => p.occupied).map(p => p.port))]
      ]));
      const errBox = BMUtil.el('pre', { class: 'mono', style: 'font-size:11px;max-height:180px;overflow:auto;white-space:pre-wrap' });
      errBox.textContent = (d.recentErrors || []).join('\n') || '(no warnings or errors in the recent ring)';
      section(`Recent warnings & errors (${(d.recentErrors || []).length})`, errBox);
      section('Compatibility results', kv((d.compatResults || []).map(r => [r.key, `${r.outcome}${r.stale ? ' (stale)' : ''}`])));
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(BMUtil.el('div', { class: 'model-err', text: '⚠ ' + e.message }));
    }
  }

  async function exportReport() {
    try {
      const path = await window.Bridge.diagnostics.exportReport();
      toast(`Diagnostic report saved locally: ${path}. Nothing was transmitted.`, 'ok', 6500);
    } catch (e) { toast(e.message, 'err'); }
  }

  return { init, load };
})();
