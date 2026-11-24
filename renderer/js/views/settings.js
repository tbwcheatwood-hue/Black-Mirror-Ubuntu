'use strict';
/* Settings view + shared UI helpers (toast, modal). */
const SettingsView = (() => {
  const $ = id => document.getElementById(id);
  const state = { config: null, schema: [] };

  async function init() {
    state.config = await window.Bridge.getConfig();
    state.schema = await window.Bridge.engines.paramSchema();
    renderNetwork();
    renderParams();
    renderChat();
    renderDiag();
  }

  function renderNetwork() {
    const box = $('settings-network');
    const bindSel = BMUtil.el('select', {}, [
      BMUtil.el('option', { value: '127.0.0.1', text: '127.0.0.1 — localhost only (recommended)' }),
      BMUtil.el('option', { value: '0.0.0.0', text: '0.0.0.0 — reachable from your LAN' })
    ]);
    bindSel.value = state.config.network.bind || '127.0.0.1';
    const portInput = BMUtil.el('input', { type: 'number', value: state.config.network.defaultPort });
    const save = BMUtil.el('button', { class: 'btn btn-primary btn-sm', text: 'Save network settings', onclick: async () => {
      await window.Bridge.setConfig('network.bind', bindSel.value);
      await window.Bridge.setConfig('network.defaultPort', Number(portInput.value));
      toast('Network settings saved — new servers will use them', 'ok');
      if (bindSel.value === '0.0.0.0') toast('Reminder: 0.0.0.0 exposes your API to the local network without authentication.', 'warn');
    } });
    box.appendChild(BMUtil.el('div', { class: 'settings-row' }, [
      BMUtil.el('span', { text: 'Default network binding' }), bindSel,
      BMUtil.el('span', { class: 'hint', text: '127.0.0.1 keeps the OpenAI-compatible API private. 0.0.0.0 lets other devices on your network use your models — there is no authentication, so use this only on trusted networks. Existing running servers keep their current binding until restarted.' })
    ]));
    box.appendChild(BMUtil.el('div', { class: 'settings-row' }, [
      BMUtil.el('span', { text: 'Default API port' }), portInput,
      BMUtil.el('span', { class: 'hint', text: 'llama.cpp builds default to 8081/8082/8083 per engine; Ollama uses 11434 and Lemonade 8000. Ports in use are detected before launch.' })
    ]));
    box.appendChild(save);
  }

  function renderParams() {
    const box = $('settings-params');
    box.innerHTML = '';
    const grid = BMUtil.el('div', { class: 'launch-grid' });
    const inputs = {};
    for (const f of state.schema) {
      const val = state.config.params[f.id] ?? f.default;
      let input;
      if (f.type === 'enum') input = BMUtil.el('select', {}, f.options.map(o => BMUtil.el('option', { value: o, text: o, selected: o === val ? '' : null })));
      else if (f.type === 'bool') { input = BMUtil.el('input', { type: 'checkbox' }); input.checked = !!val; }
      else input = BMUtil.el('input', { type: 'number', min: f.min, max: f.max, step: f.step || 1, value: val });
      inputs[f.id] = input;
      grid.appendChild(BMUtil.el('label', {}, [BMUtil.el('span', { text: f.label }), input]));
    }
    box.appendChild(grid);
    box.appendChild(BMUtil.el('button', { class: 'btn btn-primary btn-sm', style: 'margin-top:10px', text: 'Save defaults', onclick: async () => {
      const patch = {};
      for (const f of state.schema) patch[f.id] = f.type === 'bool' ? inputs[f.id].checked : (f.type === 'int' || f.type === 'float' ? Number(inputs[f.id].value) : inputs[f.id].value);
      state.config.params = await window.Bridge.setParams(patch);
      toast('Default inference parameters saved', 'ok');
    } }));
    box.appendChild(BMUtil.el('p', { class: 'hint', style: 'margin-top:8px', text: 'Defaults apply to new servers and new chats. Per-model profiles (Model Library → card → details) override these for a specific model.' }));
  }

  function renderChat() {
    const box = $('settings-chat');
    const showThinking = BMUtil.el('input', { type: 'checkbox' });
    showThinking.checked = state.config.chat.showThinking !== false;
    box.appendChild(BMUtil.el('div', { class: 'settings-row' }, [
      BMUtil.el('label', { class: 'check' }, [showThinking, BMUtil.el('span', { text: 'Display thinking / reasoning output when the model provides it' })]),
      BMUtil.el('span', { class: 'hint', text: 'Works with models that emit reasoning (llama.cpp --reasoning-format deepseek, Ollama thinking models, <think> tags).' })
    ]));
    box.appendChild(BMUtil.el('button', { class: 'btn btn-primary btn-sm', text: 'Save', onclick: async () => {
      await window.Bridge.setConfig('chat.showThinking', showThinking.checked);
      toast('Saved', 'ok');
    } }));
  }

  function renderDiag() {
    const box = $('settings-diag');
    const levels = ['debug', 'info', 'warn', 'error'];
    const sel = BMUtil.el('select', {}, levels.map(l => BMUtil.el('option', { value: l, text: l, selected: (state.config.logging.level || 'info') === l ? '' : null })));
    box.appendChild(BMUtil.el('div', { class: 'settings-row' }, [
      BMUtil.el('span', { text: 'Diagnostic log level' }), sel,
      BMUtil.el('span', { class: 'hint', text: `Logs are written under the Black Mirror data directory (logs/blackmirror-*.log). App version ${window.Bridge.versions.app} · Electron ${window.Bridge.versions.electron || 'n/a'}` })
    ]));
    box.appendChild(BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'Open data folder', onclick: async () => {
      if (window.Bridge.openDataDir) {
        try {
          const p = await window.Bridge.openDataDir();
          toast('Data folder: ' + p, 'ok', 6000);
          return;
        } catch (e) { toast(e.message, 'err'); return; }
      }
      const linux = window.Bridge.platform === 'linux';
      toast(linux ? 'Data folder: ~/.local/share/black-mirror (XDG)' : 'Data folder: %APPDATA%\\BlackMirror', 'ok', 6000);
    } }));
    box.appendChild(BMUtil.el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:8px', text: 'Save log level', onclick: async () => {
      await window.Bridge.setConfig('logging.level', sel.value);
      toast('Log level saved (applies on next start)', 'ok');
    } }));
  }

  return { init };
})();

/* ---------- shared toast & modal ---------- */
function toast(message, kind = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  const t = BMUtil.el('div', { class: `toast toast-${kind === 'info' ? 'ok' : kind}`, role: 'status', 'aria-live': 'polite' }, [BMUtil.el('span', { text: message })]);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function modal(title) {
  const root = document.getElementById('modal-root');
  root.classList.remove('hidden');
  root.innerHTML = '';
  const m = BMUtil.el('div', { class: 'modal glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [BMUtil.el('h3', { text: title })]);
  root.appendChild(m);
  root.addEventListener('click', e => { if (e.target === root) closeModal(); }, { once: true });
  return m;
}
function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

/**
 * Electron-compatible replacements for window.prompt()/window.confirm()
 * (both are unsupported in Electron and would throw at runtime).
 */
function uiPrompt(title, { placeholder = '', value = '', hint = '' } = {}) {
  return new Promise(resolve => {
    const m = modal(title);
    const input = BMUtil.el('input', { type: 'text', placeholder, 'aria-label': title });
    input.value = value || '';
    const done = (result) => { closeModal(); resolve(result); };
    const submit = () => done(input.value.trim() || null);
    m.appendChild(BMUtil.el('div', { class: 'settings-row' }, [
      input,
      hint ? BMUtil.el('span', { class: 'hint', text: hint }) : null
    ]));
    m.appendChild(BMUtil.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:6px' }, [
      BMUtil.el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => done(null) }),
      BMUtil.el('button', { class: 'btn btn-primary', text: 'OK', onclick: submit })
    ]));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 50);
  });
}

function uiConfirm(title, message, { danger = true, confirmLabel = 'Confirm' } = {}) {
  return new Promise(resolve => {
    const m = modal(title);
    m.appendChild(BMUtil.el('p', { text: message, style: 'line-height:1.55;color:var(--text-1)' }));
    const done = (result) => { closeModal(); resolve(result); };
    m.appendChild(BMUtil.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px' }, [
      BMUtil.el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => done(false) }),
      BMUtil.el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmLabel, onclick: () => done(true) })
    ]));
    setTimeout(() => m.querySelector('.btn-danger, .btn-primary').focus(), 50);
  });
}
