'use strict';
/* Inference Engines view. */
const EnginesView = (() => {
  const $ = id => document.getElementById(id);
  let statuses = [];

  async function init() {
    await reload();
  }

  async function reload() {
    const [st, hw] = await Promise.all([window.Bridge.engines.status(), window.Bridge.engines.hardware()]);
    statuses = st;
    renderHw(hw);
    render();
  }

  function renderHw(hw) {
    const rows = [
      ['CPU', `${hw.cpuModel} (${hw.cpuCores} threads)`],
      ['RAM', BMUtil.formatBytes(hw.totalMemBytes)],
      ['OS', `${hw.platform} ${hw.arch}`],
      ['Vulkan', hw.vulkan === 'available' ? 'available' : hw.vulkan === 'likely' ? 'likely (GPU present)' : hw.vulkan],
      ['SYCL / Level Zero', hw.sycl],
      ['NVIDIA GPU', hw.nvidia ? `${hw.nvidia.name} (${hw.nvidia.vramMB} MB)` : 'not detected']
    ];
    $('hw-details').innerHTML = rows.map(([k, v]) => `<div class="hw-row"><span class="k">${BMUtil.esc(k)}</span><span class="mono">${BMUtil.esc(v)}</span></div>`).join('');
    $('hw-summary').textContent = `${hw.cpuModel} · ${BMUtil.formatBytes(hw.totalMemBytes)} RAM`;
  }

  function render() {
    const grid = $('engines-grid');
    grid.innerHTML = '';
    for (const e of statuses) grid.appendChild(card(e));
  }

  function card(e) {
    const c = BMUtil.el('div', { class: 'engine-card glass' });
    const cat = e.statusCategory || e.status || 'not-installed';
    const badgeCls = { available: 'badge badge-on', compatible: 'badge badge-on', experimental: 'badge badge-warn', error: 'badge badge-err', 'not-installed': 'badge' }[cat] || 'badge';
    const badgeText = { available: 'ready', compatible: 'ready · verified fit', experimental: 'experimental', error: 'error', 'not-installed': 'not installed' }[cat] || cat;
    c.appendChild(BMUtil.el('div', { class: 'engine-head' }, [
      BMUtil.el('div', {}, [
        BMUtil.el('div', { class: 'engine-title', text: e.displayName }),
        BMUtil.el('div', { class: 'engine-sub', text: `${e.acceleration} · default port ${e.defaultPort || '—'}` })
      ]),
      BMUtil.el('div', { class: 'spacer' }),
      BMUtil.el('span', { class: badgeCls, text: badgeText, title: e.statusReason || '' })
    ]));
    if (e.version) c.appendChild(BMUtil.el('div', { class: 'small dim mono', text: `version: ${e.version.label}` }));
    if (e.error) c.appendChild(BMUtil.el('div', { class: 'model-err', text: '⚠ ' + e.error }));
    if (e.statusReason) c.appendChild(BMUtil.el('div', { class: 'engine-note', text: e.statusReason }));
    if (e.statusNote) c.appendChild(BMUtil.el('div', { class: 'engine-note', text: e.statusNote }));
    // probed capabilities (from the binary itself where available)
    const pc = e.probedCapabilities;
    if (pc && pc.probed) {
      const bits = [];
      bits.push(`thinking: ${pc.thinking || '?'}`);
      if (pc.kvCacheTypes) bits.push(`kv: ${pc.kvCacheTypes.join('/')}`);
      if (pc.flashAttention) bits.push('flash-attn');
      if (pc.cpuMoeOffload) bits.push('cpu-moe-offload');
      if (pc.mmproj || pc.images === 'mmproj-supported') bits.push('mmproj');
      if (pc.devices && pc.devices.length) bits.push(`${pc.devices.length} device(s)`);
      c.appendChild(BMUtil.el('div', { class: 'small', style: 'color:var(--violet-0)', text: 'probed: ' + bits.join(' · ') }));
    } else if (pc && pc.note) {
      c.appendChild(BMUtil.el('div', { class: 'small dim', text: `probe: ${pc.note}` }));
    }

    // installed versions
    if (e.versions && e.versions.length) {
      const vs = BMUtil.el('div', { class: 'engine-versions' });
      for (const v of e.versions) {
        vs.appendChild(BMUtil.el('div', { class: 'engine-version-row' }, [
          BMUtil.el('span', { text: v.active ? '● ' : '○ ', style: 'color:var(--violet-0)' }),
          BMUtil.el('span', { text: v.label }),
          BMUtil.el('span', { text: v.installedAt ? new Date(v.installedAt).toLocaleDateString() : '', class: 'dim small' }),
          BMUtil.el('span', { class: 'spacer' }),
          !v.active ? BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'activate (rollback)', onclick: async () => { await window.Bridge.engines.setActive(e.id, v.tag); reload(); toast(`Switched ${e.displayName} to ${v.label}`, 'ok'); } }) : null,
          BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'remove', onclick: async () => {
            if (!(await uiConfirm('Remove engine version', `Remove installed version ${v.label}? Only files inside Black Mirror's engines folder are deleted.`))) return;
            await window.Bridge.engines.uninstall(e.id, v.tag); reload();
          } })
        ]));
      }
      c.appendChild(vs);
    }

    // notes / capabilities
    if (e.hardware && e.hardware.notes) c.appendChild(BMUtil.el('div', { class: 'engine-note', text: e.hardware.notes }));
    if (e.capabilities && e.capabilities.thinking) {
      c.appendChild(BMUtil.el('div', { class: 'small dim', text: `capabilities: thinking (${e.capabilities.thinking})${e.capabilities.images ? ', images' : ''}${e.capabilities.embeddings ? ', embeddings' : ''}` }));
    }

    const actions = BMUtil.el('div', { class: 'engine-actions' });
    // Attach engines (LM Studio) run their own server — there is nothing to install.
    if (!e.installed && e.lifecycle !== 'attach') {
      const installBtn = BMUtil.el('button', { class: 'btn btn-primary btn-sm', text: '⬇ Install' });
      installBtn.setAttribute('aria-label', `Install ${e.displayName}`);
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.textContent = '⟳ Installing…';
        toast(`Installing ${e.displayName}…`);
        try { await window.Bridge.engines.install(e.id); toast(`${e.displayName} installed`, 'ok'); reload(); }
        catch (err) { toast(err.message, 'err'); installBtn.disabled = false; installBtn.textContent = '⬇ Install'; }
      });
      actions.appendChild(installBtn);
    }
    actions.appendChild(BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'Custom executable path…', onclick: () => setCustomPath(e) }));
    c.appendChild(actions);
    return c;
  }

  async function setCustomPath(e) {
    const p = await uiPrompt(`Custom executable — ${e.displayName}`, {
      placeholder: 'e.g. D:\\tools\\llama.cpp\\llama-server.exe',
      hint: 'Leave empty to clear the override and use the installed version.'
    });
    if (p === null) return;
    try {
      await window.Bridge.engines.setCustomPath(e.id, p.trim() || null);
      reload();
      toast(p ? 'Custom path saved' : 'Custom path cleared', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  return { init };
})();
