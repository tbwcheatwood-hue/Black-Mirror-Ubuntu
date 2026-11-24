'use strict';
/* Markdown rendering with syntax highlighting + copy buttons. */
const BMMarkdown = {
  render(text) {
    const raw = marked.parse(text || '', { breaks: true, gfm: true });
    const tpl = document.createElement('template');
    tpl.innerHTML = raw;
    // highlight code fences
    if (window.hljs) {
      tpl.content.querySelectorAll('pre code').forEach(block => {
        try { hljs.highlightElement(block); } catch (_) { /* ignore */ }
      });
    }
    // wrap pre in a container with a copy button
    tpl.content.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      const lang = (code && code.className.match(/language-([\w-]+)/) || [])[1] || '';
      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = 'copy';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(() => {
          btn.textContent = 'copied';
          setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        });
      });
      if (lang) {
        const tag = document.createElement('span');
        tag.className = 'code-lang small dim';
        tag.textContent = lang;
        tag.style.cssText = 'position:absolute;top:8px;left:12px;';
        wrap.appendChild(tag);
      }
      wrap.appendChild(pre);
      wrap.appendChild(btn);
      pre.replaceWith(wrap);
    });
    // sanitize: drop script/iframe/event handlers
    tpl.content.querySelectorAll('script,iframe,object,embed,link,style').forEach(n => n.remove());
    tpl.content.querySelectorAll('*').forEach(n => {
      for (const attr of [...n.attributes || []]) {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
        if (attr.name === 'href' && /^\s*javascript:/i.test(attr.value)) n.removeAttribute(attr.name);
      }
    });
    return tpl.content;
  }
};
