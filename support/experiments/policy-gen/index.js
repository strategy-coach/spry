// index.js (ES module). No globals; classes use EventTarget + CustomEvent.

const STORAGE_KEY = 'policy-generator:model:v1';

class DataModel {
  #state = {};
  get(path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.#state); }
  set(path, value) {
    const parts = path.split('.'); let cur = this.#state;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] ?? {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
  }
  toJSON() { return structuredClone(this.#state); }
  load(json) { this.#state = structuredClone(json || {}); }
  loadFromForm(formEl) {
    formEl.querySelectorAll('[data-path]').forEach((el) => {
      const path = el.getAttribute('data-path');
      const val = el.type === 'checkbox' ? !!el.checked : el.value;
      if (path) this.set(path, val);
    });
  }
}

class FormView extends EventTarget {
  #root; #model; #formEl;
  constructor(rootEl, model) { super(); this.#root = rootEl; this.#model = model; }
  mount() {
    const tpl = document.getElementById('form-template');
    this.#root.innerHTML = ''; this.#root.appendChild(tpl.content.cloneNode(true));
    this.#formEl = this.#root.querySelector('#policy-form');
    this.setValues(this.#model.toJSON());
    this.#formEl.addEventListener('input', () => this.#onChange(), { passive: true });
    this.#formEl.addEventListener('change', () => this.#onChange());
  }
  #onChange() {
    this.#model.loadFromForm(this.#formEl);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#model.toJSON())); } catch { }
    this.dispatchEvent(new CustomEvent('form:changed', { detail: { model: this.#model.toJSON() } }));
  }
  setValues(json) {
    this.#root.querySelectorAll('[data-path]').forEach((el) => {
      const path = el.getAttribute('data-path'); if (!path) return;
      const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
      if (v == null) return;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
  }
}

class NavView extends EventTarget {
  #root; #docs;
  constructor(containerEl, docs) { super(); this.#root = containerEl; this.#docs = docs; this.render(); }
  render() {
    this.#root.innerHTML = '';
    this.#docs.forEach((d) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = d.title;
      btn.dataset.id = d.id; btn.dataset.file = d.file;
      btn.addEventListener('click', () => { this.dispatchEvent(new CustomEvent('doc:selected', { detail: d })); this.#highlight(d.id); });
      const item = document.createElement('div'); item.role = 'listitem'; item.appendChild(btn);
      this.#root.appendChild(item);
    });
  }
  #highlight(id) {
    this.#root.querySelectorAll('button').forEach((b) => b.classList.toggle('contrast', b.dataset.id === id));
  }
}

class TemplateLoader {
  async load(filePath) {
    const res = await fetch(filePath, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Failed to load ${filePath}: ${res.status}`);
    return await res.text();
  }
}

class PlaceholderScanner {
  scan(markdown) {
    const found = new Set(); const re = /{{\s*([#\^\/&>{!]*)\s*([\w.]+)?[^}]*}}/g; let m;
    while ((m = re.exec(markdown)) !== null) { const type = (m[1] || '').trim(); const name = (m[2] || '').trim(); if (!name) continue; if (type === '!') continue; found.add(name); }
    return Array.from(found);
  }
}

class Renderer {
  #md = window.markdownit({ html: false, linkify: true, typographer: true });
  renderFilledMarkdown(markdown, data) { return Mustache.render(markdown, data); }
  renderHTMLFromMarkdown(filledMd) { return this.#md.render(filledMd); }
  render(markdown, data) { return this.renderHTMLFromMarkdown(this.renderFilledMarkdown(markdown, data)); }
}

class PreviewView {
  #el; constructor(containerEl) { this.#el = containerEl; }
  setHTML(html) { this.#el.innerHTML = html; }
  getHTML() { return this.#el.innerHTML; }
  getPlainText() { const t = document.createElement('div'); t.innerHTML = this.getHTML(); return t.textContent || ''; }
}

class ClipboardService {
  static async copy(html, text) {
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const item = new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) });
        await navigator.clipboard.write([item]); return true;
      } catch { }
    }
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return true; } catch { } }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
  }
}

class DownloadService {
  static download(filename, mime, content) {
    const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
}

class PlaceholderView {
  #root; constructor(listEl) { this.#root = listEl; }
  render(names, model) {
    this.#root.innerHTML = '';
    if (!names.length) { this.#root.innerHTML = '<li><small class="muted">No placeholders detected.</small></li>'; return; }
    for (const name of names.sort()) {
      const val = name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), model);
      const ok = !(val == null || val === '');
      const li = document.createElement('li');
      li.innerHTML = `<code>${name}</code> — <span class="${ok ? 'ok' : 'missing'}">${ok ? 'OK' : 'Missing'}</span>`;
      this.#root.appendChild(li);
    }
  }
}

class AppController extends EventTarget {
  #model; #formView; #navView; #loader; #renderer; #preview; #scanner; #placeholderView;
  #contentEl; #toolbarEl; #copyBtn; #downloadHTMLBtn; #downloadMDBtn; #showFormBtn;
  #currentDoc = null; #currentMarkdown = '';

  constructor({ contentEl, toolbarEl, showFormBtnEl, docsEl, copyBtnEl, downloadHTMLBtnEl, downloadMDBtnEl, placeholderListEl, docsManifest }) {
    super();
    this.#model = new DataModel();
    this.#contentEl = contentEl;
    this.#toolbarEl = toolbarEl;               // <--- toolbar container to toggle
    this.#formView = new FormView(this.#contentEl, this.#model);
    this.#navView = new NavView(docsEl, docsManifest);
    this.#loader = new TemplateLoader();
    this.#renderer = new Renderer();
    this.#preview = new PreviewView(this.#contentEl);
    this.#scanner = new PlaceholderScanner();
    this.#placeholderView = new PlaceholderView(placeholderListEl);
    this.#copyBtn = copyBtnEl; this.#downloadHTMLBtn = downloadHTMLBtnEl; this.#downloadMDBtn = downloadMDBtnEl;
    this.#showFormBtn = showFormBtnEl;

    // Load saved model if present
    try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (saved) this.#model.load(saved); } catch { }

    // Events
    this.#navView.addEventListener('doc:selected', (e) => this.#onDocSelected(e.detail));
    this.#copyBtn.addEventListener('click', () => this.#onCopyClicked());
    this.#downloadHTMLBtn.addEventListener('click', () => this.#onDownloadHTML());
    this.#downloadMDBtn.addEventListener('click', () => this.#onDownloadMD());
    this.#showFormBtn.addEventListener('click', () => this.showForm());
    this.#formView.addEventListener('form:changed', () => this.#renderIfDocSelected());

    // Show the form by default on first load
    this.showForm();
  }

  // Public: can be called from boot/elsewhere
  showForm() {
    this.#currentDoc = null;          // clear current policy context
    this.#setToolbarVisible(false);   // hide policy toolbar while form is shown
    this.#formView.mount();
    if (this.#currentMarkdown) {
      const names = this.#scanner.scan(this.#currentMarkdown);
      this.#placeholderView.render(names, this.#model.toJSON());
    }
  }

  async #onDocSelected(doc) {
    this.#currentDoc = doc;
    try {
      this.#currentMarkdown = await this.#loader.load(doc.file);
      await this.#render();
      const names = this.#scanner.scan(this.#currentMarkdown);
      this.#placeholderView.render(names, this.#model.toJSON());
      this.#setToolbarVisible(true);  // show toolbar when a policy is on screen
    } catch (err) {
      this.#preview.setHTML(`<p role="alert">Error: ${String(err)}</p>`);
      this.#setToolbarVisible(false);
      console.error(err);
    }
  }

  async #renderIfDocSelected() {
    if (this.#currentDoc) {
      await this.#render();
      const names = this.#scanner.scan(this.#currentMarkdown);
      this.#placeholderView.render(names, this.#model.toJSON());
    }
  }

  async #render() {
    try {
      const html = this.#renderer.render(this.#currentMarkdown, this.#model.toJSON());
      this.#preview.setHTML(html);
      this.dispatchEvent(new CustomEvent('render:done', { detail: { doc: this.#currentDoc } }));
    } catch (err) {
      this.#preview.setHTML(`<p role="alert">Error: ${String(err)}</p>`);
      console.error(err);
    }
  }

  async #onCopyClicked() {
    const ok = await ClipboardService.copy(this.#preview.getHTML(), this.#preview.getPlainText());
    this.#flash(ok ? 'Copied!' : 'Copy failed');
  }

  #onDownloadHTML() {
    const id = this.#currentDoc?.id ?? 'policy';
    const html = this.#preview.getHTML();
    const wrapped = `<!doctype html><meta charset="utf-8"><title>${id}</title>${html}`;
    DownloadService.download(`${id}-filled.html`, 'text/html', wrapped);
  }

  #onDownloadMD() {
    if (!this.#currentDoc) return this.#flash('Select a policy first');
    const id = this.#currentDoc.id;
    const filledMd = this.#renderer.renderFilledMarkdown(this.#currentMarkdown, this.#model.toJSON());
    DownloadService.download(`${id}-filled.md`, 'text/markdown', filledMd);
  }

  #setToolbarVisible(on) {
    if (!this.#toolbarEl) return;
    this.#toolbarEl.hidden = !on;
  }

  #flash(msg) {
    const d = document.createElement('dialog');
    d.innerHTML = `<article><p>${msg}</p></article>`;
    document.body.appendChild(d);
    d.addEventListener('click', () => d.close());
    d.addEventListener('close', () => d.remove());
    d.showModal();
    setTimeout(() => d.close(), 1200);
  }
}

// Bootstrap when libs are ready
document.addEventListener('DOMContentLoaded', () => {
  const wait = () => (window.Mustache && window.markdownit) ? Promise.resolve() : new Promise((r) => setTimeout(() => r(wait()), 10));
  wait().then(() => {
    const contentEl = document.getElementById('content');
    const toolbarEl = document.getElementById('policy-toolbar');
    const showFormBtnEl = document.getElementById('show-form-btn');
    const docsEl = document.getElementById('docs-list');
    const copyBtnEl = document.getElementById('copy-btn');
    const downloadHTMLBtnEl = document.getElementById('download-html-btn');
    const downloadMDBtnEl = document.getElementById('download-md-btn');
    const placeholderListEl = document.getElementById('placeholder-list');
    const docsScript = document.getElementById('docs');
    const docsManifest = JSON.parse(docsScript.textContent || '[]');

    new AppController({
      contentEl, toolbarEl, showFormBtnEl, docsEl,
      copyBtnEl, downloadHTMLBtnEl, downloadMDBtnEl,
      placeholderListEl, docsManifest
    });
  });
});
