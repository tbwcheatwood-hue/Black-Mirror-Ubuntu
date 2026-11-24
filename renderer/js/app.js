'use strict';
/* App bootstrap + router. */
(async () => {
  const $ = id => document.getElementById(id);

  // preview banner
  if (window.PreviewMode) $('preview-banner').classList.remove('hidden');
  else if (window.LiveWeb) {
    const b = $('preview-banner');
    b.textContent = 'UBUNTU LIVE — this view is the real Black Mirror backend on this machine. Hardware lines are probed, not simulated. GPU acceleration is shown only when a probe answers.';
    b.classList.remove('hidden');
  }

  // navigation
  const views = ['chat', 'library', 'engines', 'servers', 'compatlab', 'diagnostics', 'performance', 'benchmarks', 'settings'];
  function navigate(name) {
    if (!views.includes(name)) name = 'chat';
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    location.hash = name;
    if (name === 'servers') ServersView.reload();
  }
  document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
  window.addEventListener('hashchange', () => navigate(location.hash.replace('#', '')));

  // init views
  await ChatView.init();
  await LibraryView.init();
  await EnginesView.init();
  await ServersView.init();
  await CompatLabView.init();
  await DiagnosticsView.init();
  await PerformanceView.init();
  await BenchmarksView.init();
  await SettingsView.init();

  // First-run onboarding: a dismissible 3-step guide (engine → models → launch).
  const config = await window.Bridge.getConfig();
  if (!config.firstRunDone) showOnboarding();

  function showOnboarding() {
    const steps = [
      { n: 1, title: 'Install an inference engine', body: 'Open Inference Engines and install llama.cpp (CPU is the safe default on any machine; Vulkan/SYCL target your integrated GPU when the driver runtime supports it).', view: 'engines', cta: 'Go to Inference Engines' },
      { n: 2, title: 'Index your models', body: 'Add your existing GGUF folders in the Model Library. Files are indexed in place — Black Mirror never copies, moves or modifies them.', view: 'library', cta: 'Go to Model Library' },
      { n: 3, title: 'Launch a server and chat', body: 'Load a model, review the pre-load memory assessment, launch — then chat locally or point any OpenAI-compatible app at the endpoint.', view: 'servers', cta: 'Go to Servers' }
    ];
    const root = document.getElementById('modal-root');
    root.classList.remove('hidden');
    root.innerHTML = '';
    const m = BMUtil.el('div', { class: 'modal glass onboarding' });
    m.appendChild(BMUtil.el('h3', { text: 'Welcome to Black Mirror v1.2.2' }));
    m.appendChild(BMUtil.el('p', { class: 'dim', text: 'Three steps to your first local conversation. Everything runs on this machine — no accounts, no cloud, no telemetry.' }));
    for (const st of steps) {
      m.appendChild(BMUtil.el('div', { class: 'onboarding-step' }, [
        BMUtil.el('span', { class: 'onboarding-num', text: String(st.n) }),
        BMUtil.el('div', {}, [
          BMUtil.el('strong', { text: st.title }),
          BMUtil.el('p', { text: st.body, style: 'margin:4px 0 0;color:var(--text-1);font-size:13px;line-height:1.5' })
        ])
      ]));
    }
    const skip = BMUtil.el('button', { class: 'btn btn-ghost', text: 'Skip — I know my way around' });
    const go = BMUtil.el('button', { class: 'btn btn-primary', text: 'Start: install an engine →' });
    skip.addEventListener('click', () => finish());
    go.addEventListener('click', () => { finish(); navigate('engines'); });
    m.appendChild(BMUtil.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px' }, [skip, go]));
    root.appendChild(m);
    async function finish() {
      root.classList.add('hidden');
      root.innerHTML = '';
      try { await window.Bridge.setConfig('firstRunDone', true); } catch (_) { /* ignore */ }
    }
  }

  navigate(location.hash.replace('#', '') || 'chat');
})().catch(e => {
  console.error(e);
  const box = document.getElementById('toasts');
  if (box) {
    const t = document.createElement('div');
    t.className = 'toast toast-err';
    t.textContent = 'Startup failed: ' + e.message;
    box.appendChild(t);
  }
});
