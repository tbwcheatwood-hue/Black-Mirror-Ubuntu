'use strict';
/* Servers view: launch form, lifecycle controls, live logs, external processes. */
const ServersView = (() => {
  const $ = id => document.getElementById(id);
  const state = { servers: [], paramSchema: [], config: null, selectedId: null, logTimer: null };

  async function init() {
    state.config = await window.Bridge.getConfig();
    state.paramSchema = await window.Bridge.engines.paramSchema();
    $('btn-new-server').addEventListener('click', showLaunchForm);
    $('btn-connect-remote').addEventListener('click', showRemoteForm);
    await reload();
    window.Bridge.on('server-state', onServerState);
    window.Bridge.on('server-event', onServerEvent);
    window.Bridge.on('server-log', onServerLog);
    onServerState(await window.Bridge.servers.list());
  }

  /* ---------- remote endpoint connect (never owned) ---------- */
  function showRemoteForm() {
    const wrap = modal('Connect to an OpenAI-compatible endpoint');
    const form = BMUtil.el('div', { class: 'launch-form' });
    form.appendChild(BMUtil.el('p', { class: 'dim small', text: 'Connect to an existing local or remote inference server without taking ownership. Black Mirror lists it, tests connectivity and lets you chat through it — it will never launch or terminate anything on the remote side.' }));
    const urlInput = BMUtil.el('input', { type: 'text', placeholder: 'http://192.168.1.10:8080/v1', 'aria-label': 'Endpoint base URL' });
    const labelInput = BMUtil.el('input', { type: 'text', placeholder: 'Display label (optional)', 'aria-label': 'Endpoint label' });
    form.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Base URL' }), urlInput]));
    form.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Label' }), labelInput]));
    const testOut = BMUtil.el('div', { class: 'dim small' });
    const testBtn = BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: '⇄ Test first' });
    const addBtn = BMUtil.el('button', { class: 'btn btn-primary', text: 'Connect' });
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true; testBtn.textContent = '⟳ Testing…';
      const url = urlInput.value.trim();
      const res = await window.Bridge.servers.testRemote(url);
      testBtn.disabled = false; testBtn.textContent = '⇄ Test first';
      testOut.className = res.ok ? 'small' : 'small model-err';
      testOut.textContent = res.ok
        ? `✓ Reachable in ${res.latencyMs} ms — models: ${res.models.slice(0, 5).join(', ') || '(none listed)'}${res.models.length > 5 ? ` +${res.models.length - 5} more` : ''}`
        : `✕ ${res.error}`;
    });
    addBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) { toast('Enter an endpoint URL first', 'warn'); return; }
      try {
        const r = await window.Bridge.servers.addRemote({ label: labelInput.value.trim(), baseUrl: url });
        await window.Bridge.servers.testRemote(r.id);
        closeModal();
        toast('Endpoint connected (read-only ownership)', 'ok');
        reload();
      } catch (e) { toast(e.message, 'err'); }
    });
    form.appendChild(BMUtil.el('div', { style: 'display:flex;gap:8px;align-items:center' }, [testBtn, testOut]));
    form.appendChild(BMUtil.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, [addBtn]));
    wrap.appendChild(form);
  }

  function onServerEvent(e) {
    if (e.event === 'server-exit') {
      reload();
    }
  }

  function onServerState(servers) { state.servers = servers || []; render(); }
  function onServerLog(e) {
    if (state.selectedId && e.id === state.selectedId) appendLog(e.line);
  }

  async function reload() {
    state.servers = await window.Bridge.servers.list();
    render();
    renderExternal();
  }

  function render() {
    const grid = $('servers-grid');
    grid.innerHTML = '';
    if (!state.servers.length) {
      grid.appendChild(BMUtil.el('div', { class: 'dim', text: 'No servers. Use “Launch model server” to load a model from your library.' }));
    }
    for (const s of state.servers) grid.appendChild(card(s));
  }

  function card(s) {
    const running = s.status === 'running';
    const c = BMUtil.el('div', { class: 'server-card glass' + (state.selectedId === s.id ? ' selected' : '') });
    const badge = running ? 'badge badge-on' : s.status === 'starting' ? 'badge badge-warn' : s.status === 'crashed' ? 'badge badge-err' : 'badge';
    const head = BMUtil.el('div', { class: 'server-head' }, [
      BMUtil.el('input', { type: 'radio', name: 'sel-server', style: 'display:none', checked: state.selectedId === s.id }),
      BMUtil.el('span', { class: 'server-name', text: s.displayName || s.model }),
      BMUtil.el('span', { class: badge, text: s.status }),
      BMUtil.el('span', { class: 'badge', text: `${s.engineId}` }),
      running ? BMUtil.el('span', { class: 'server-addr mono', text: s.baseUrl + '/v1', title: 'Copy API endpoint', onclick: () => { navigator.clipboard.writeText(s.baseUrl + '/v1'); toast('Endpoint copied', 'ok'); } }) : null,
      s.startedAt ? BMUtil.el('span', { class: 'dim small', text: `up ${BMUtil.formatDuration((Date.now() - s.startedAt) / 1000)} · pid ${s.pid}` }) : null
    ]);
    head.addEventListener('click', () => selectServer(s));
    c.appendChild(head);

    const actions = BMUtil.el('div', { class: 'server-actions' });
    const act = (label, fn, cls = 'btn-ghost', disabled) => {
      const b = BMUtil.el('button', { class: `btn ${cls} btn-sm`, text: label, onclick: fn });
      if (disabled) b.disabled = true;
      actions.appendChild(b);
    };
    if (s.mode === 'remote') {
      // Connect-only endpoints: test + forget. Never stoppable — they are
      // not owned by Black Mirror and may not even run on this machine.
      act('⇄ Test connection', async () => {
        const res = await window.Bridge.servers.testRemote(s.id);
        if (res.ok) toast(`Connected in ${res.latencyMs} ms · ${res.models.length} model(s)`, 'ok');
        else toast(`Unreachable: ${res.error}`, 'err');
        reload();
      });
      act('✕ Forget', async () => {
        if (!(await uiConfirm('Forget endpoint', `Stop showing ${s.displayName || s.baseUrl}? Nothing on the remote is affected.`))) return;
        await window.Bridge.servers.removeRemote(s.id);
        reload();
      });
      c.appendChild(actions);
      return c;
    }
    act('■ Stop', async () => { try { await window.Bridge.servers.stop(s.id); reload(); toast('Server stopped', 'ok'); } catch (e) { toast(e.message, 'err'); } }, 'btn-danger', !running && s.status !== 'starting');
    act('⟳ Restart', async () => { try { await window.Bridge.servers.restart(s.id); reload(); toast('Restarted', 'ok'); } catch (e) { toast(e.message, 'err'); } }, 'btn-ghost', !running);
    act('▤ Logs', () => selectServer(s));
    c.appendChild(actions);
    return c;
  }

  function selectServer(s) {
    state.selectedId = s.id;
    $('log-server-title').textContent = `${s.displayName || s.model} (${s.id})`;
    render();
    window.Bridge.servers.logs(s.id).then(lines => {
      $('server-log').textContent = lines.join('\n') || '(no log lines yet)';
      $('server-log').scrollTop = $('server-log').scrollHeight;
    });
  }

  function appendLog(line) {
    const pre = $('server-log');
    pre.textContent += (pre.textContent ? '\n' : '') + line;
    pre.scrollTop = pre.scrollHeight;
  }

  async function renderExternal() {
    const box = $('external-procs');
    try {
      const procs = await window.Bridge.servers.external();
      if (!procs.length) { box.innerHTML = '<div class="dim small">None detected.</div>'; return; }
      box.innerHTML = '';
      for (const p of procs) {
        box.appendChild(BMUtil.el('div', { class: 'external-row' }, [
          BMUtil.el('span', { class: 'mono', text: `pid ${p.pid}` }),
          BMUtil.el('span', { text: p.name }),
          BMUtil.el('span', { class: 'dim', text: BMUtil.formatBytes(p.memoryBytes) }),
          BMUtil.el('span', { class: p.managed ? 'badge badge-on' : 'badge', text: p.managed ? 'managed by Black Mirror' : 'external (never touched)' })
        ]));
      }
    } catch (_) { box.innerHTML = '<div class="dim small">Process listing unavailable.</div>'; }
  }

  /* ---------- launch form ---------- */
  function showLaunchForm() {
    const wrap = modal('Launch model server');
    const form = BMUtil.el('div', { class: 'launch-form' });
    form.appendChild(BMUtil.el('p', { class: 'dim small', text: 'The context length you set here is passed to the engine exactly as configured — Black Mirror never silently reduces it.' }));

    (async () => {
      const [engines, models] = await Promise.all([window.Bridge.engines.status(), window.Bridge.library.list({ onlyValid: true })]);
      const usable = engines.filter(e => e.status === 'available');

      // engine select
      const engineSel = BMUtil.el('select');
      for (const e of usable) engineSel.appendChild(BMUtil.el('option', { value: e.id, text: e.displayName }));
      if (!usable.length) {
        form.appendChild(BMUtil.el('p', { class: 'model-err', text: 'No usable engines installed. Install one in Inference Engines first.' }));
        return;
      }
      // model select (library models for gguf-path engines; server model list for ollama/lemonade)
      const modelSel = BMUtil.el('select');
      const fillModels = async () => {
        modelSel.innerHTML = '';
        const eng = usable.find(e => e.id === engineSel.value);
        if (eng && (eng.family === 'ollama' || eng.family === 'lemonade')) {
          try {
            const list = await window.Bridge.servers.engineModels(eng.id);
            for (const m of (list || [])) modelSel.appendChild(BMUtil.el('option', { value: m.id, text: `${m.displayName || m.id}${m.parameterSize ? ' · ' + m.parameterSize : ''}${m.quant ? ' · ' + m.quant : ''}` }));
          } catch (e) {
            modelSel.appendChild(BMUtil.el('option', { value: '__none__', text: `(service offline: ${e.message})` }));
          }
          modelSel.appendChild(BMUtil.el('option', { value: '__none__', text: '(engine manages its own models)' }));
        } else {
          for (const m of models) {
            const splitTag = m.split ? ` · shard ${m.split.index}/${m.split.total}` : '';
            modelSel.appendChild(BMUtil.el('option', { value: m.path, text: `${m.name} · ${m.quant || '?'} · ${BMUtil.formatBytes(m.splitTotalBytes || m.sizeBytes)}${splitTag}` }));
          }
        }
        assessNow();
      };
      engineSel.addEventListener('change', fillModels);

      // params grid from schema + config defaults
      const paramsGrid = BMUtil.el('div', { class: 'launch-grid' });
      const inputs = {};
      let mmprojSel = null;
      for (const f of state.paramSchema) {
        const val = (state.config.params || {})[f.id] ?? f.default;
        let input;
        if (f.type === 'enum') {
          input = BMUtil.el('select', {}, f.options.map(o => BMUtil.el('option', { value: o, text: o === 'auto' ? 'auto (model default)' : o === 'on' ? 'on (enable reasoning)' : o === 'off' ? 'off (explicitly disable)' : o, selected: o === val ? '' : null })));
        } else if (f.type === 'bool') {
          input = BMUtil.el('input', { type: 'checkbox' }); input.checked = !!val;
        } else if (f.type === 'path') {
          input = BMUtil.el('select');
          input.appendChild(BMUtil.el('option', { value: '', text: 'none' }));
          input.dataset.kind = 'mmproj';
          mmprojSel = input;
        } else if (f.type === 'string') {
          input = BMUtil.el('input', { type: 'text', placeholder: f.placeholder || '' }); input.value = val || '';
        } else {
          input = BMUtil.el('input', { type: 'number', min: f.min, max: f.max, step: f.step || 1, value: val });
        }
        inputs[f.id] = input;
        const label = BMUtil.el('label', {}, [BMUtil.el('span', { text: f.label }), input]);
        paramsGrid.appendChild(label);
      }
      // populate mmproj candidates when a model is picked
      const refreshMmproj = async () => {
        if (!mmprojSel) return;
        try {
          const cands = await window.Bridge.library.mmprojFor(modelSel.value);
          mmprojSel.innerHTML = '<option value="">none</option>';
          for (const c of (cands || [])) mmprojSel.appendChild(BMUtil.el('option', { value: c.path, text: c.fileName }));
        } catch (_) { /* preview */ }
      };
      modelSel.addEventListener('change', refreshMmproj);

      // network
      const netGrid = BMUtil.el('div', { class: 'launch-grid' });
      const portInput = BMUtil.el('input', { type: 'number', value: state.config.network.defaultPort || 8081 });
      const bindSel = BMUtil.el('select', {}, [
        BMUtil.el('option', { value: '127.0.0.1', text: '127.0.0.1 — this machine only (recommended)' }),
        BMUtil.el('option', { value: '0.0.0.0', text: '0.0.0.0 — expose to LAN (no auth!)' })
      ]);
      netGrid.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: 'API port' }), portInput]));
      netGrid.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Network binding' }), bindSel]));

      // assessment box
      const assessBox = BMUtil.el('div', { class: 'assess-box assess-ok' });
      const assessNow = async () => {
        const model = models.find(m => m.path === modelSel.value);
        if (!model) { assessBox.className = 'assess-box assess-ok'; assessBox.textContent = 'Select a model to see the pre-load memory assessment.'; return; }
        try {
          const { estimate, verdict } = await window.Bridge.library.assess(model.path, Number(inputs.contextLength.value) || 8192, Number(inputs.parallelSlots.value) || 1);
          assessBox.className = `assess-box assess-${verdict.level}`;
          assessBox.innerHTML = '';
          assessBox.appendChild(BMUtil.el('strong', { text: `${verdict.level === 'ok' ? '✓ Fits comfortably' : verdict.level === 'caution' ? '◔ Heavier load' : verdict.level === 'warning' ? '⚠ High memory pressure' : '⚠ Likely to fail'} — estimated ${BMUtil.formatBytes(verdict.need)} (free: ${BMUtil.formatBytes(verdict.free)})` }));
          if (verdict.notes.length) assessBox.appendChild(BMUtil.el('ul', {}, verdict.notes.map(n => BMUtil.el('li', { text: n }))));
        } catch (_) { /* preview */ }
      };
      inputs.contextLength.addEventListener('change', assessNow);
      inputs.parallelSlots.addEventListener('change', assessNow);
      modelSel.addEventListener('change', assessNow);

      form.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Inference engine' }), engineSel]));
      form.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: 'Model' }), modelSel]));
      form.appendChild(paramsGrid);
      form.appendChild(netGrid);
      form.appendChild(assessBox);
      await fillModels();

      const launch = BMUtil.el('button', { class: 'btn btn-primary', text: '▶ Launch server', onclick: async () => {
        const params = {};
        for (const f of state.paramSchema) {
          const v = inputs[f.id];
          params[f.id] = f.type === 'bool' ? v.checked : (f.type === 'int' || f.type === 'float' ? Number(v.value) : v.value);
        }
        try {
          const model = modelSel.value === '__none__' ? null : modelSel.value;
          const s = await window.Bridge.servers.start({
            engineId: engineSel.value,
            modelPath: model,
            port: Number(portInput.value),
            bind: bindSel.value,
            params,
            modelDisplayName: model ? model.split(/[\\/]/).pop().replace(/\.gguf$/, '') : 'engine-managed'
          });
          closeModal();
          toast(`Server running on port ${s.port}`, 'ok');
          reload();
        } catch (e) {
          toast(e.message, 'err');
        }
      } });
      form.appendChild(launch);
    })();

    wrap.appendChild(form);
  }

  return { init, reload };
})();
