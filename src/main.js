'use strict';
/* Notepad for Linux — Windows 11 Notepad look-alike (Tauri v2). */
const T = window.__TAURI__;
const invoke = T.core.invoke;
const appWindow = T.window.getCurrentWindow();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const basename = (p) => p.split(/[\\/]/).pop();

/* ---------------- settings ---------------- */
const DEFAULTS = { theme: 'system', fontFamily: 'Consolas', fontStyle: 'Regular', fontSize: 11, wordWrap: true, statusBar: true, matchCase: false, wrapAround: true };
let S = Object.assign({}, DEFAULTS, safeJSON(localStorage.getItem('np.settings')));
let themeOverride = null;
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { localStorage.setItem('np.settings', JSON.stringify(S)); }
window.addEventListener('storage', (e) => {
  if (e.key === 'np.settings') { S = Object.assign({}, DEFAULTS, safeJSON(e.newValue)); applyAll(); }
});

const MONO_FALLBACK = '"Cascadia Mono", "Cascadia Code", "Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", monospace';
const FONT_STYLES = ['Light', 'Regular', 'Italic', 'Bold', 'Bold Italic'];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const EOL_LABEL = { CRLF: 'Windows (CRLF)', LF: 'Unix (LF)', CR: 'Macintosh (CR)' };
const EOL_STR = { CRLF: '\r\n', LF: '\n', CR: '\r' };
const ENCODINGS = ['UTF-8', 'UTF-8 with BOM', 'UTF-16 LE', 'UTF-16 BE', 'ANSI'];
const FILTERS = [{ name: 'Text documents (*.txt)', extensions: ['txt'] }, { name: 'All files (*.*)', extensions: ['*'] }];

const mq = matchMedia('(prefers-color-scheme: dark)');
function effectiveTheme() { const t = themeOverride || S.theme; return t === 'system' ? (mq.matches ? 'dark' : 'light') : t; }
function applyTheme() { document.documentElement.dataset.theme = effectiveTheme(); }
mq.addEventListener('change', applyTheme);

/* ---------------- state ---------------- */
let tabs = [];
let active = null;
let seq = 1;
let zoom = 100;
let settingsOpen = false;
let dialogOpen = false;

function applyEditorStyle() {
  const px = (S.fontSize * 4 / 3) * zoom / 100;
  const st = document.documentElement.style;
  st.setProperty('--ed-font', `"${S.fontFamily}", ${MONO_FALLBACK}`);
  st.setProperty('--ed-size', px.toFixed(2) + 'px');
  st.setProperty('--ed-weight', /Bold/.test(S.fontStyle) ? '700' : /Light/.test(S.fontStyle) ? '300' : '400');
  st.setProperty('--ed-style', /Italic/.test(S.fontStyle) ? 'italic' : 'normal');
  document.body.classList.toggle('nowrap', !S.wordWrap);
  tabs.forEach((t) => (t.ta.wrap = S.wordWrap ? 'soft' : 'off'));
  $('#statusbar').classList.toggle('hidden', !S.statusBar);
  $('#zoomLabel').textContent = zoom + '%';
  $('#fontPreview').style.fontSize = (S.fontSize * 4 / 3).toFixed(2) + 'px';
}
function applyAll() { applyTheme(); applyEditorStyle(); syncSettingsUI(); updateStatus(); }

/* ---------------- tabs ---------------- */
function newTab(opts = {}) {
  const ta = el('textarea', 'editor');
  ta.spellcheck = false;
  ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('autocapitalize', 'off');
  ta.wrap = S.wordWrap ? 'soft' : 'off';
  ta.value = opts.text || '';
  const tab = { id: seq++, path: opts.path || null, name: opts.name || 'Untitled', encoding: opts.encoding || 'UTF-8', eol: opts.eol || 'CRLF', saved: ta.value, dirty: false, ta };
  tab.hist = { undo: [], redo: [], last: null };
  ta.addEventListener('beforeinput', (e) => recordHistory(tab, e));
  ta.addEventListener('input', () => { markDirty(tab); scheduleStatus(); hideOverlay(); updateFindCount(); });
  ta.addEventListener('scroll', syncOverlayScroll);
  ta.addEventListener('focus', hideOverlay);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); insertText('\t'); }
  });
  ta.addEventListener('wheel', onWheel, { passive: false });
  ta.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY); });
  $('#editors').appendChild(ta);
  const idx = active ? tabs.indexOf(active) + 1 : tabs.length;
  tabs.splice(idx, 0, tab);
  if (settingsOpen) closeSettings(false);
  activate(tab);
  return tab;
}

function activate(tab) {
  if (!tab) return;
  active = tab;
  tabs.forEach((t) => t.ta.classList.toggle('active', t === tab));
  renderTabs();
  updateTitle();
  updateStatus();
  hideOverlay();
  updateFindCount();
  if (!settingsOpen && !dialogOpen) requestAnimationFrame(() => tab.ta.focus());
}

function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  for (const t of tabs) {
    const d = el('div', 'tab' + (t === active ? ' active' : '') + (t.dirty ? ' dirty' : ''));
    d.setAttribute('role', 'tab');
    d.title = t.path || t.name;
    d.innerHTML = `<span class="sep"></span><span class="cl"></span><span class="tab-title"></span><button class="tab-close" tabindex="-1" title="Close Tab (Ctrl+W)"><span class="dot"></span>${ICON.close10}</button><span class="cr"></span>`;
    d.querySelector('.tab-title').textContent = t.name;
    d.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('.tab-close')) { if (settingsOpen) closeSettings(false); activate(t); }
      if (e.button === 1) { e.preventDefault(); closeTab(t); }
    });
    d.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });
    box.appendChild(d);
  }
  const a = box.querySelector('.tab.active');
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function markDirty(tab) {
  const d = tab.ta.value !== tab.saved;
  if (d !== tab.dirty) { tab.dirty = d; renderTabs(); updateTitle(); }
}

function updateTitle() {
  if (!active) return;
  const t = `${active.dirty ? '*' : ''}${active.name} - Notepad`;
  document.title = t;
  appWindow.setTitle(t).catch(() => {});
}

/* ---------------- status bar ---------------- */
let statusPending = false;
function scheduleStatus() {
  if (statusPending) return;
  statusPending = true;
  requestAnimationFrame(() => { statusPending = false; updateStatus(); });
}
document.addEventListener('selectionchange', scheduleStatus);

function updateStatus() {
  if (!active) return;
  const ta = active.ta, v = ta.value;
  const pos = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
  let ln = 1, last = -1;
  for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) { ln++; last = i; }
  $('#stPos').textContent = `Ln ${ln}, Col ${pos - last}`;
  const sel = ta.selectionEnd - ta.selectionStart, n = v.length;
  $('#stChars').textContent = sel
    ? `${sel.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} characters`
    : `${n.toLocaleString('en-US')} character${n === 1 ? '' : 's'}`;
  $('#stEol').textContent = EOL_LABEL[active.eol];
  $('#stEnc').textContent = active.encoding;
  $('#zoomLabel').textContent = zoom + '%';
}

/* ---------------- undo / redo ----------------
   WebKitGTK's native textarea undo stack is unreliable inside Tauri, so each tab
   keeps its own snapshot history (typing is coalesced into runs, like Notepad). */
let forceNewGroup = false;
const COALESCE = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);
function snapshot(ta) { return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd, dir: ta.selectionDirection }; }
function recordHistory(tab, e) {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); e.inputType === 'historyUndo' ? undo() : redo(); return; }
  const h = tab.hist, ta = tab.ta, now = Date.now(), L = h.last;
  const coalesce = !forceNewGroup && L && COALESCE.has(e.inputType) && L.type === e.inputType && now - L.t < 2000 &&
    ta.selectionStart === ta.selectionEnd && ta.selectionStart === L.pos && !(e.data && /\s/.test(e.data) && !/\s/.test(L.data || ''));
  if (forceNewGroup === 'skip') { /* snapshot already taken by caller */ }
  else if (!coalesce) {
    h.undo.push(snapshot(ta));
    if (h.undo.length > 300) h.undo.shift();
  }
  h.redo = [];
  forceNewGroup = false;
  const delta = e.inputType === 'insertText' ? (e.data || '').length : e.inputType === 'deleteContentBackward' ? -1 : 0;
  h.last = { type: e.inputType, t: now, pos: ta.selectionStart + delta, data: e.data };
}
function restoreSnap(tab, st) {
  const ta = tab.ta;
  ta.value = st.v;
  ta.setSelectionRange(st.s, st.e, st.dir || 'none');
  tab.hist.last = null;
  markDirty(tab); updateStatus(); hideOverlay(); updateFindCount();
  scrollToSelection(ta);
}
function undo() {
  if (!active) return; const h = active.hist;
  if (!h.undo.length) return;
  h.redo.push(snapshot(active.ta));
  restoreSnap(active, h.undo.pop());
  active.ta.focus();
}
function redo() {
  if (!active) return; const h = active.hist;
  if (!h.redo.length) return;
  h.undo.push(snapshot(active.ta));
  restoreSnap(active, h.redo.pop());
  active.ta.focus();
}

/* ---------------- editing helpers ---------------- */
function insertText(s) {
  const ta = active.ta;
  ta.focus();
  forceNewGroup = true;
  if (!document.execCommand('insertText', false, s)) {
    active.hist.undo.push(snapshot(ta)); active.hist.redo = [];
    ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
}
function execEdit(cmd) { if (cmd === 'undo') return undo(); if (cmd === 'redo') return redo(); active.ta.focus(); document.execCommand(cmd); }
async function doCopy(cut) {
  const ta = active.ta;
  const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (!s) return;
  try { await invoke('plugin:clipboard-manager|write_text', { text: s }); }
  catch { ta.focus(); document.execCommand('copy'); }
  if (cut) { ta.focus(); forceNewGroup = true; document.execCommand('delete'); }
}
async function doPaste() {
  let s = '';
  try { s = await invoke('plugin:clipboard-manager|read_text'); } catch { return; }
  if (s) insertText(s.replace(/\r\n?/g, '\n'));
}
function doDelete() {
  const ta = active.ta; ta.focus(); forceNewGroup = true;
  if (ta.selectionStart !== ta.selectionEnd) document.execCommand('delete');
  else document.execCommand('forwardDelete');
}
function insertTimeDate() {
  const d = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
  insertText(`${time} ${date}`);
}

/* ---------------- zoom ---------------- */
function setZoom(z) {
  zoom = Math.max(10, Math.min(500, Math.round(z / 10) * 10));
  applyEditorStyle(); updateStatus(); hideOverlay();
}
function onWheel(e) {
  if (e.ctrlKey) { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 10 : -10)); }
}

/* ---------------- files ---------------- */
function detectEol(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/(?<!\r)\n/g) || []).length;
  const cr = (raw.match(/\r(?!\n)/g) || []).length;
  if (!crlf && !lf && !cr) return 'CRLF';
  if (crlf >= lf && crlf >= cr) return 'CRLF';
  return lf >= cr ? 'LF' : 'CR';
}
function addRecent(p) {
  let r = safeJSONArr(localStorage.getItem('np.recent')).filter((x) => x !== p);
  r.unshift(p); localStorage.setItem('np.recent', JSON.stringify(r.slice(0, 10)));
}
function safeJSONArr(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }

async function openPath(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) { if (settingsOpen) closeSettings(false); activate(existing); return; }
  let f;
  try {
    f = await invoke('read_file', { path });
  } catch (err) {
    const msg = String(err);
    if (msg.startsWith('NOTFOUND:')) {
      const r = await showDialog({
        title: 'Notepad',
        content: `Cannot find the ${basename(path)} file.\n\nDo you want to create a new file?`,
        buttons: [{ label: 'Yes', value: 'yes', primary: true }, { label: 'No', value: 'no', cancel: true }],
      });
      if (r === 'yes') {
        try { await invoke('write_file', { path, text: '', encoding: 'UTF-8' }); return openPath(path); }
        catch (e2) { await messageBox(String(e2)); }
      }
    } else {
      await messageBox(msg);
    }
    return;
  }
  const eol = detectEol(f.text);
  const text = f.text.replace(/\r\n?/g, '\n');
  const reuse = active && !active.path && !active.dirty && active.ta.value === '';
  if (reuse) {
    Object.assign(active, { path: f.path, name: f.name, encoding: f.encoding, eol, saved: text, dirty: false });
    active.ta.value = text;
    active.hist = { undo: [], redo: [], last: null };
    active.ta.setSelectionRange(0, 0);
    active.ta.scrollTop = 0;
    if (settingsOpen) closeSettings(false);
    activate(active);
  } else {
    newTab({ path: f.path, name: f.name, text, encoding: f.encoding, eol });
    active.ta.setSelectionRange(0, 0);
  }
  addRecent(f.path);
}

async function openFile() {
  let r;
  try { r = await invoke('plugin:dialog|open', { options: { multiple: true, directory: false, filters: FILTERS } }); }
  catch (e) { return messageBox(String(e)); }
  if (!r) return;
  for (const p of [].concat(r)) await openPath(typeof p === 'string' ? p : p.path);
}

async function saveTab(tab, as = false) {
  if (!tab) return false;
  let path = tab.path;
  if (!path || as) {
    try {
      path = await invoke('plugin:dialog|save', {
        options: { defaultPath: tab.path || (tab.name === 'Untitled' ? 'Untitled.txt' : tab.name), filters: FILTERS },
      });
    } catch (e) { await messageBox(String(e)); return false; }
    if (!path) return false;
    if (typeof path !== 'string') path = path.path;
  }
  const text = tab.ta.value.replace(/\n/g, EOL_STR[tab.eol]);
  try {
    const name = await invoke('write_file', { path, text, encoding: tab.encoding });
    Object.assign(tab, { path, name, saved: tab.ta.value });
    markDirty(tab); tab.dirty = false;
    renderTabs(); updateTitle(); addRecent(path);
    return true;
  } catch (e) {
    await messageBox(String(e));
    return false;
  }
}
async function saveAll() { for (const t of [...tabs]) if (t.dirty || !t.path) { activate(t); if (!(await saveTab(t))) return; } }

function askSave(tab) {
  return showDialog({
    title: 'Notepad',
    content: `Do you want to save changes to ${tab.path || tab.name}?`,
    buttons: [
      { label: 'Save', value: 'save', primary: true },
      { label: "Don't save", value: 'discard' },
      { label: 'Cancel', value: 'cancel', cancel: true },
    ],
  });
}
async function closeTab(tab) {
  if (!tab) return false;
  if (tab.dirty) {
    activate(tab);
    const r = await askSave(tab);
    if (r === 'cancel') return false;
    if (r === 'save' && !(await saveTab(tab))) return false;
  }
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.ta.remove();
  if (!tabs.length) { await appWindow.destroy(); return true; }
  if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
  return true;
}
let closing = false;
async function closeWindow() {
  if (closing) return;
  closing = true;
  try {
    for (const t of [...tabs]) {
      if (!t.dirty) continue;
      if (settingsOpen) closeSettings(false);
      activate(t);
      const r = await askSave(t);
      if (r === 'cancel') return;
      if (r === 'save' && !(await saveTab(t))) return;
    }
    await appWindow.destroy();
  } finally { closing = false; }
}
function newWindow() { invoke('new_window').catch((e) => messageBox(String(e))); }

/* ---------------- dialogs ---------------- */
function showDialog({ title, content, buttons, onOpen }) {
  return new Promise((resolve) => {
    closeMenus();
    dialogOpen = true;
    const prevFocus = document.activeElement;
    const layer = $('#dialogLayer');
    layer.innerHTML = '';
    layer.classList.remove('hidden');
    const dlg = el('div', 'dialog');
    dlg.setAttribute('role', 'dialog');
    dlg.innerHTML = '<div class="dialog-body"><h2></h2><div class="dialog-content"></div></div><div class="dialog-footer"></div>';
    dlg.querySelector('h2').textContent = title;
    const c = dlg.querySelector('.dialog-content');
    if (typeof content === 'string') c.style.whiteSpace = 'pre-line', (c.textContent = content);
    else c.appendChild(content);
    const footer = dlg.querySelector('.dialog-footer');
    let primaryBtn = null;
    const finish = (v) => {
      layer.classList.add('hidden'); layer.innerHTML = '';
      document.removeEventListener('keydown', kd, true);
      dialogOpen = false;
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const attempt = (b) => { if (b.validate && !b.validate()) return; finish(b.value); };
    for (const b of buttons) {
      const btn = el('button', 'btn' + (b.primary ? ' accent' : ''));
      btn.textContent = b.label;
      btn.addEventListener('click', () => attempt(b));
      footer.appendChild(btn);
      if (b.primary) primaryBtn = [btn, b];
    }
    const cancelB = buttons.find((b) => b.cancel);
    const kd = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelB ? cancelB.value : null); }
      else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const f = document.activeElement;
        if (f && f.tagName === 'BUTTON' && dlg.contains(f)) f.click();
        else if (primaryBtn) attempt(primaryBtn[1]);
      } else if (e.key === 'Tab') {
        const items = $$('input,button', dlg);
        const i = items.indexOf(document.activeElement);
        e.preventDefault(); e.stopPropagation();
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      } else if ((e.ctrlKey || e.altKey) && e.key !== 'Control' && e.key !== 'Alt') {
        const allowed = ['a', 'c', 'v', 'x', 'z'];
        if (!(e.ctrlKey && allowed.includes(e.key.toLowerCase()))) { e.preventDefault(); e.stopPropagation(); }
      }
    };
    document.addEventListener('keydown', kd, true);
    layer.appendChild(dlg);
    const inp = dlg.querySelector('input');
    if (inp) { inp.focus(); inp.select(); } else if (primaryBtn) primaryBtn[0].focus();
    if (onOpen) onOpen(dlg);
  });
}
function messageBox(msg) { return showDialog({ title: 'Notepad', content: msg, buttons: [{ label: 'OK', value: 'ok', primary: true, cancel: true }] }); }

async function goToLine() {
  const ta = active.ta;
  const lines = ta.value.split('\n').length;
  const cur = ta.value.slice(0, ta.selectionStart).split('\n').length;
  const box = el('div');
  box.innerHTML = '<label>Line number</label><div class="textbox"><input type="text" inputmode="numeric" /></div><div class="dialog-error"></div>';
  const inp = box.querySelector('input'), err = box.querySelector('.dialog-error');
  inp.value = String(cur);
  inp.addEventListener('input', () => { err.textContent = ''; });
  let target = null;
  const r = await showDialog({
    title: 'Go to line',
    content: box,
    buttons: [
      {
        label: 'Go to', value: 'go', primary: true,
        validate: () => {
          const n = parseInt(inp.value.trim(), 10);
          if (!/^\d+$/.test(inp.value.trim()) || n < 1) { err.textContent = 'Enter a valid line number.'; return false; }
          if (n > lines) { err.textContent = 'The line number is beyond the total number of lines.'; return false; }
          target = n; return true;
        },
      },
      { label: 'Cancel', value: 'cancel', cancel: true },
    ],
  });
  if (r !== 'go') return;
  let pos = 0;
  for (let i = 1; i < target; i++) pos = ta.value.indexOf('\n', pos) + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  scrollToSelection(ta);
}

/* ---------------- find / replace ---------------- */
const findBar = $('#findBar'), findInput = $('#findInput'), replaceInput = $('#replaceInput');
let findOpen = false;
function openFind(replace) {
  if (settingsOpen) closeSettings(false);
  const ta = active.ta;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findOpen = true;
  findBar.classList.remove('hidden');
  findBar.classList.toggle('replace', !!replace);
  $('#findToggle').innerHTML = replace ? ICON.chevUp : ICON.chevDown;
  findInput.focus(); findInput.select();
  updateFindCount();
}
function closeFind() {
  findOpen = false;
  findBar.classList.add('hidden');
  hideOverlay();
  active.ta.focus();
}
function matchesOf(q) {
  if (!q) return 0;
  const re = new RegExp(escapeRe(q), S.matchCase ? 'g' : 'gi');
  return (active.ta.value.match(re) || []).length;
}
function updateFindCount() {
  if (!findOpen) return;
  const q = findInput.value;
  const n = q ? matchesOf(q) : -1;
  $('#findCount').textContent = n === 0 ? 'No results' : '';
}
function find(dir = 1) {
  const q = findInput.value;
  if (!q) { openFind(findBar.classList.contains('replace')); return; }
  const ta = active.ta;
  const v = S.matchCase ? ta.value : ta.value.toLowerCase();
  const qq = S.matchCase ? q : q.toLowerCase();
  let i;
  if (dir > 0) {
    i = v.indexOf(qq, ta.selectionEnd);
    if (i < 0 && S.wrapAround) i = v.indexOf(qq);
  } else {
    const from = ta.selectionStart - qq.length;
    i = from >= 0 ? v.lastIndexOf(qq, from) : -1;
    if (i < 0 && S.wrapAround) i = v.lastIndexOf(qq);
  }
  if (i < 0) {
    if (findOpen) { $('#findCount').textContent = 'No results'; }
    else messageBox(`Cannot find "${q}"`);
    return;
  }
  const fromBar = document.activeElement && document.activeElement.closest && document.activeElement.closest('#findBar');
  const ae = document.activeElement;
  ta.setSelectionRange(i, i + q.length);
  if (fromBar) { ae.focus(); showOverlay(true); }
  else { ta.focus(); scrollToSelection(ta); }
  updateStatus();
}
function replaceOne() {
  const q = findInput.value; if (!q) return;
  const ta = active.ta;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const same = S.matchCase ? sel === q : sel.toLowerCase() === q.toLowerCase();
  if (same) {
    const ae = document.activeElement;
    ta.focus(); forceNewGroup = true; document.execCommand('insertText', false, replaceInput.value);
    if (ae && ae.focus) ae.focus();
  }
  find(1);
}
function replaceAll() {
  const q = findInput.value; if (!q) return;
  const ta = active.ta;
  const re = new RegExp(escapeRe(q), S.matchCase ? 'g' : 'gi');
  const rep = replaceInput.value;
  const nv = ta.value.replace(re, () => rep);
  if (nv === ta.value) { $('#findCount').textContent = 'No results'; return; }
  const ae = document.activeElement;
  active.hist.undo.push(snapshot(ta));
  ta.focus(); ta.select(); forceNewGroup = 'skip';
  if (!document.execCommand('insertText', false, nv)) { forceNewGroup = false; ta.value = nv; ta.dispatchEvent(new Event('input')); }
  ta.setSelectionRange(0, 0); ta.scrollTop = 0;
  if (ae && ae.focus) ae.focus();
  updateFindCount();
}

/* mirror overlay that keeps the current match highlighted while focus is in the find bar */
const overlay = $('#findOverlay');
function buildMirror(ta, s, e) {
  const v = ta.value;
  overlay.textContent = '';
  overlay.append(document.createTextNode(v.slice(0, s)));
  const m = el('mark'); m.textContent = v.slice(s, e) || '\u200b';
  overlay.append(m, document.createTextNode(v.slice(e, e + 4000)));
  overlay.style.width = ta.clientWidth + 'px';
  overlay.style.height = ta.clientHeight + 'px';
  return m;
}
function ensureVisible(ta, m) {
  const top = m.offsetTop, h = m.offsetHeight;
  if (top < ta.scrollTop || top + h > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  const left = m.offsetLeft;
  if (left < ta.scrollLeft || left + m.offsetWidth > ta.scrollLeft + ta.clientWidth) ta.scrollLeft = Math.max(0, left - ta.clientWidth / 3);
}
function showOverlay(ensure) {
  const ta = active.ta;
  if (ta.selectionStart === ta.selectionEnd) return hideOverlay();
  const m = buildMirror(ta, ta.selectionStart, ta.selectionEnd);
  if (ensure) ensureVisible(ta, m);
  overlay.scrollTop = ta.scrollTop; overlay.scrollLeft = ta.scrollLeft;
  overlay.classList.add('show');
}
function scrollToSelection(ta) {
  const m = buildMirror(ta, ta.selectionStart, ta.selectionEnd);
  ensureVisible(ta, m);
  overlay.textContent = '';
}
function hideOverlay() { overlay.classList.remove('show'); overlay.textContent = ''; }
function syncOverlayScroll() {
  if (!overlay.classList.contains('show')) return;
  overlay.scrollTop = active.ta.scrollTop; overlay.scrollLeft = active.ta.scrollLeft;
}

findInput.addEventListener('input', () => { updateFindCount(); hideOverlay(); });
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey && e.altKey) replaceAll(); else replaceOne(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#findNext').addEventListener('click', () => find(1));
$('#findPrev').addEventListener('click', () => find(-1));
$('#findClose').addEventListener('click', closeFind);
$('#replaceOne').addEventListener('click', replaceOne);
$('#replaceAll').addEventListener('click', replaceAll);
$('#findToggle').addEventListener('click', () => {
  const r = !findBar.classList.contains('replace');
  findBar.classList.toggle('replace', r);
  $('#findToggle').innerHTML = r ? ICON.chevUp : ICON.chevDown;
  (r ? replaceInput : findInput).focus();
});
$('#findOpts').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu([
    { label: 'Match case', checked: S.matchCase, act: () => { S.matchCase = !S.matchCase; saveSettings(); updateFindCount(); } },
    { label: 'Wrap around', checked: S.wrapAround, act: () => { S.wrapAround = !S.wrapAround; saveSettings(); } },
  ], r.right - 200, r.bottom + 4, { anchor: e.currentTarget, restoreFocus: findInput });
});

/* ---------------- flyout menus ---------------- */
let menuStack = []; // [{el, items, focus, anchor}]
let menubarOpen = null; // menu key while a menubar menu is open
function closeMenus() {
  const restore = menuStack[0] && menuStack[0].restoreFocus;
  $('#menuLayer').innerHTML = '';
  menuStack = [];
  menubarOpen = null;
  $$('.menu-btn.open, .icon-btn.open, .combo.open').forEach((b) => b.classList.remove('open'));
  if (restore && restore.focus) restore.focus();
}
function closeMenusFrom(level) {
  while (menuStack.length > level) menuStack.pop().el.remove();
}
let cachedMenuSb = null;
function menuScrollbarWidth() {
  if (cachedMenuSb != null) return cachedMenuSb;
  const p = document.createElement('div');
  p.className = 'flyout';
  p.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px;height:40px;max-height:none;overflow-y:scroll;visibility:hidden;animation:none;pointer-events:none';
  const inner = document.createElement('div');
  inner.style.height = '80px';
  p.appendChild(inner);
  document.body.appendChild(p);
  const cs = getComputedStyle(p);
  const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  cachedMenuSb = Math.max(0, Math.round(p.offsetWidth - p.clientWidth - borders));
  p.remove();
  if (!cachedMenuSb) cachedMenuSb = 12;
  return cachedMenuSb;
}
function showMenu(items, x, y, opts = {}) {
  const level = opts.level || 0;
  if (level === 0) closeMenus(); else closeMenusFrom(level);
  const f = el('div', 'flyout');
  if (items.some((i) => i.checked !== undefined)) f.classList.add('has-checks');
  const entry = { el: f, items, focus: -1, restoreFocus: opts.restoreFocus || null };
  const rows = [];
  items.forEach((it, idx) => {
    if (it.sep) { f.appendChild(el('div', 'sep')); rows.push(null); return; }
    const r = el('div', 'mi' + (it.disabled ? ' disabled' : ''));
    r.innerHTML = `<span class="mi-check">${it.checked ? ICON.check : ''}</span><span class="mi-label"></span><span class="mi-key"></span>${it.submenu ? `<span class="mi-arrow">${ICON.chevRight}</span>` : ''}`;
    r.querySelector('.mi-label').textContent = it.label;
    r.querySelector('.mi-key').textContent = it.key || '';
    if (it.font) r.querySelector('.mi-label').style.fontFamily = `"${it.font}", var(--ui-font)`;
    r.addEventListener('mouseenter', () => {
      setMenuFocus(entry, idx);
      if (it.submenu && !it.disabled) openSub(entry, idx, level);
      else closeMenusFrom(level + 1);
    });
    r.addEventListener('click', (e) => { e.stopPropagation(); activateItem(entry, idx, level); });
    f.appendChild(r); rows.push(r);
  });
  entry.rows = rows;
  $('#menuLayer').appendChild(f);
  // A short window used to slide the menu up over the menubar label.
  // Menubar menus stay under the label and scroll. Other menus flip up
  // only when the whole list fits above the anchor.
  // Width is locked here. WebKit adds the scrollbar after the open
  // animation and the menu would grow about 0.2s later.
  const margin = 4;
  const W = window.innerWidth, H = window.innerHeight;
  f.style.animation = 'none';
  f.style.boxSizing = 'border-box';
  f.style.width = 'max-content';
  f.style.maxHeight = 'none';
  f.style.overflowX = 'hidden';
  f.style.overflowY = 'hidden';
  const naturalW = f.offsetWidth;
  const naturalH = f.offsetHeight;
  let top = y;
  let maxH = Math.max(96, H - margin * 2);
  if (opts.pinBelow) {
    top = y;
    maxH = Math.max(96, H - margin - top);
  } else if (top + naturalH > H - margin) {
    const flipTop = opts.flipY != null ? opts.flipY - naturalH : null;
    if (flipTop != null && flipTop >= margin) {
      top = flipTop;
      f.classList.add('up');
    } else if (opts.flipY != null) {
      const above = opts.flipY - margin;
      const below = H - margin - y;
      if (above > below) {
        maxH = Math.max(96, above);
        top = Math.max(margin, opts.flipY - maxH);
        f.classList.add('up');
      } else {
        top = Math.max(margin, y);
        maxH = Math.max(96, H - margin - top);
      }
    } else {
      top = Math.max(margin, Math.min(y, H - margin - Math.min(naturalH, H - margin * 2)));
      maxH = Math.max(96, H - margin - top);
    }
  }
  const needsScroll = naturalH > maxH;
  const width = naturalW + (needsScroll ? menuScrollbarWidth() : 0);
  let left = x;
  if (left + width > W - margin) left = W - width - margin;
  if (left < margin) left = margin;
  f.style.width = width + 'px';
  f.style.maxHeight = maxH + 'px';
  f.style.overflowY = needsScroll ? 'scroll' : 'hidden';
  f.style.left = left + 'px';
  f.style.top = top + 'px';
  f.style.animation = '';
  menuStack[level] = entry;
  if (opts.anchor) opts.anchor.classList.add('open');
  if (opts.selectedIdx != null) {
    setMenuFocus(entry, opts.selectedIdx);
    const row = rows[opts.selectedIdx];
    if (row) f.scrollTop = Math.max(0, row.offsetTop - f.clientHeight / 2);
  }
  if (opts.focusFirst) moveFocus(entry, 1);
  return entry;
}
function openSub(entry, idx, level) {
  const it = entry.items[idx];
  const r = entry.rows[idx].getBoundingClientRect();
  const sub = showMenu(typeof it.submenu === 'function' ? it.submenu() : it.submenu, r.right - 2, r.top - 5, { level: level + 1 });
  const sr = sub.el.getBoundingClientRect();
  if (sr.left < r.right - 10) sub.el.style.left = Math.max(4, r.left - sr.width + 2) + 'px';
  return sub;
}
function setMenuFocus(entry, idx) {
  entry.rows.forEach((r, i) => r && r.classList.toggle('focused', i === idx));
  entry.focus = idx;
}
function moveFocus(entry, d) {
  const n = entry.items.length;
  let i = entry.focus;
  for (let k = 0; k < n; k++) {
    i = (i + d + n) % n;
    if (entry.rows[i] && !entry.items[i].disabled) { setMenuFocus(entry, i); entry.rows[i].scrollIntoView({ block: 'nearest' }); return; }
  }
}
function activateItem(entry, idx, level) {
  const it = entry.items[idx];
  if (!it || it.disabled || it.sep) return;
  if (it.submenu) { const s = openSub(entry, idx, level); moveFocus(s, 1); return; }
  closeMenus();
  if (it.act) setTimeout(() => it.act(), 0);
}
function handleMenuKey(e) {
  if (!menuStack.length) return false;
  const level = menuStack.length - 1, entry = menuStack[level];
  const k = e.key;
  if (k === 'ArrowDown') moveFocus(entry, 1);
  else if (k === 'ArrowUp') moveFocus(entry, -1);
  else if (k === 'Enter' || k === ' ') { if (entry.focus >= 0) activateItem(entry, entry.focus, level); }
  else if (k === 'Escape') { if (level > 0) closeMenusFrom(level); else closeMenus(); }
  else if (k === 'ArrowRight') {
    const it = entry.items[entry.focus];
    if (it && it.submenu) activateItem(entry, entry.focus, level);
    else if (menubarOpen) switchMenubar(1);
  } else if (k === 'ArrowLeft') {
    if (level > 0) closeMenusFrom(level);
    else if (menubarOpen) switchMenubar(-1);
  } else if (k === 'Tab' || k === 'Alt') { closeMenus(); }
  else if (/^[a-z]$/i.test(k) && !e.ctrlKey && !e.altKey) {
    const i = entry.items.findIndex((it) => !it.sep && !it.disabled && it.label[0].toLowerCase() === k.toLowerCase());
    if (i >= 0) { setMenuFocus(entry, i); activateItem(entry, i, level); }
  } else if (e.ctrlKey || e.altKey || /^F\d+$/.test(k)) { closeMenus(); return false; }
  else return true;
  e.preventDefault(); e.stopPropagation();
  return true;
}
document.addEventListener('mousedown', (e) => {
  if (!menuStack.length) return;
  if (e.target.closest('.flyout')) return;
  if (e.target.closest('.menu-btn') && menubarOpen) { e.preventDefault(); closeMenus(); return; }
  closeMenus();
}, true);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => { closeMenus(); hideOverlay(); });

const MENUBAR = ['file', 'edit', 'view'];
function openMenubar(key, focusFirst) {
  const btn = $(`.menu-btn[data-menu="${key}"]`);
  const r = btn.getBoundingClientRect();
  const items = key === 'file' ? menuFile() : key === 'edit' ? menuEdit() : menuView();
  const restore = active && !settingsOpen ? active.ta : null;
  showMenu(items, r.left, r.bottom + 2, { anchor: btn, focusFirst, restoreFocus: restore, pinBelow: true });
  menubarOpen = key;
}
function switchMenubar(d) {
  const i = MENUBAR.indexOf(menubarOpen);
  openMenubar(MENUBAR[(i + d + MENUBAR.length) % MENUBAR.length], true);
}
$$('.menu-btn').forEach((b) => {
  b.addEventListener('click', () => { if (menubarOpen === b.dataset.menu) closeMenus(); else openMenubar(b.dataset.menu, false); });
  b.addEventListener('mouseenter', () => { if (menubarOpen && menubarOpen !== b.dataset.menu) openMenubar(b.dataset.menu, false); });
});

function hasSel() { return active && active.ta.selectionStart !== active.ta.selectionEnd; }
function recentItems() {
  const r = safeJSONArr(localStorage.getItem('np.recent'));
  if (!r.length) return [{ label: 'No recent files', disabled: true }];
  return [...r.map((p) => ({ label: p, act: () => openPath(p) })), { sep: 1 }, { label: 'Clear recent files', act: () => localStorage.removeItem('np.recent') }];
}
function menuFile() {
  return [
    { label: 'New tab', key: 'Ctrl+N', act: () => newTab() },
    { label: 'New window', key: 'Ctrl+Shift+N', act: newWindow },
    { label: 'Open', key: 'Ctrl+O', act: openFile },
    { label: 'Recent', submenu: recentItems },
    { label: 'Save', key: 'Ctrl+S', act: () => saveTab(active) },
    { label: 'Save as', key: 'Ctrl+Shift+S', act: () => saveTab(active, true) },
    { label: 'Save all', key: 'Ctrl+Alt+S', act: saveAll },
    { sep: 1 },
    { label: 'Page setup', disabled: true },
    { label: 'Print', key: 'Ctrl+P', act: () => window.print() },
    { sep: 1 },
    { label: 'Close tab', key: 'Ctrl+W', act: () => closeTab(active) },
    { label: 'Close window', key: 'Ctrl+Shift+W', act: closeWindow },
    { label: 'Exit', act: closeWindow },
  ];
}
function menuEdit() {
  const s = hasSel();
  return [
    { label: 'Undo', key: 'Ctrl+Z', act: () => execEdit('undo') },
    { label: 'Redo', key: 'Ctrl+Y', act: () => execEdit('redo') },
    { sep: 1 },
    { label: 'Cut', key: 'Ctrl+X', disabled: !s, act: () => doCopy(true) },
    { label: 'Copy', key: 'Ctrl+C', disabled: !s, act: () => doCopy(false) },
    { label: 'Paste', key: 'Ctrl+V', act: doPaste },
    { label: 'Delete', key: 'Del', act: doDelete },
    { sep: 1 },
    { label: 'Find', key: 'Ctrl+F', act: () => openFind(false) },
    { label: 'Find next', key: 'F3', act: () => find(1) },
    { label: 'Find previous', key: 'Shift+F3', act: () => find(-1) },
    { label: 'Replace', key: 'Ctrl+H', act: () => openFind(true) },
    { label: 'Go to', key: 'Ctrl+G', act: goToLine },
    { sep: 1 },
    { label: 'Select all', key: 'Ctrl+A', act: () => { active.ta.focus(); active.ta.select(); } },
    { label: 'Time/Date', key: 'F5', act: insertTimeDate },
    { sep: 1 },
    { label: 'Font', act: () => openSettings('font') },
  ];
}
function menuView() {
  return [
    {
      label: 'Zoom', submenu: [
        { label: 'Zoom in', key: 'Ctrl+Plus', act: () => setZoom(zoom + 10) },
        { label: 'Zoom out', key: 'Ctrl+Minus', act: () => setZoom(zoom - 10) },
        { label: 'Restore default zoom', key: 'Ctrl+0', act: () => setZoom(100) },
      ],
    },
    { label: 'Status bar', checked: S.statusBar, act: () => { S.statusBar = !S.statusBar; saveSettings(); applyAll(); } },
    { label: 'Word wrap', checked: S.wordWrap, act: () => { S.wordWrap = !S.wordWrap; saveSettings(); applyAll(); } },
  ];
}
function showContextMenu(x, y) {
  const s = hasSel();
  showMenu([
    { label: 'Undo', key: 'Ctrl+Z', act: () => execEdit('undo') },
    { sep: 1 },
    { label: 'Cut', key: 'Ctrl+X', disabled: !s, act: () => doCopy(true) },
    { label: 'Copy', key: 'Ctrl+C', disabled: !s, act: () => doCopy(false) },
    { label: 'Paste', key: 'Ctrl+V', act: doPaste },
    { label: 'Delete', key: 'Del', disabled: !s, act: doDelete },
    { sep: 1 },
    { label: 'Select all', key: 'Ctrl+A', act: () => { active.ta.focus(); active.ta.select(); } },
  ], x, y, { restoreFocus: active.ta, flipY: y });
}

/* status bar menus for line ending / encoding */
$('#stEol').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(Object.keys(EOL_LABEL).map((k) => ({
    label: EOL_LABEL[k], checked: active.eol === k,
    act: () => { if (active.eol !== k) { active.eol = k; active.saved = null; markDirty(active); updateStatus(); } },
  })), r.left, r.top, { flipY: r.top - 4, restoreFocus: active.ta });
});
$('#stEnc').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(ENCODINGS.map((k) => ({
    label: k, checked: active.encoding === k,
    act: () => { if (active.encoding !== k) { active.encoding = k; active.saved = null; markDirty(active); updateStatus(); } },
  })), r.left, r.top, { flipY: r.top - 4, restoreFocus: active.ta });
});

/* ---------------- settings page ---------------- */
let fontList = null;
function openSettings(section) {
  closeMenus();
  if (findOpen) { findOpen = false; findBar.classList.add('hidden'); hideOverlay(); }
  settingsOpen = true;
  $('#mainView').classList.add('hidden');
  $('#settingsView').classList.remove('hidden');
  syncSettingsUI();
  if (section === 'font') { $('#fontCard').classList.add('open'); $('#fontCard').scrollIntoView({ block: 'center' }); }
  $('#settingsBack').focus();
  if (!fontList) invoke('list_fonts').then((l) => { fontList = l; }).catch(() => { fontList = []; });
}
function closeSettings(focus = true) {
  settingsOpen = false;
  $('#settingsView').classList.add('hidden');
  $('#mainView').classList.remove('hidden');
  if (focus && active) active.ta.focus();
}
function syncSettingsUI() {
  $$('input[name="theme"]').forEach((r) => (r.checked = r.value === S.theme));
  $('#themeValue').textContent = { light: 'Light', dark: 'Dark', system: 'Use system setting' }[S.theme];
  $('#fontFamily').innerHTML = `<span></span>${ICON.chevDown}`; $('#fontFamily span').textContent = S.fontFamily;
  $('#fontStyle').innerHTML = `<span></span>${ICON.chevDown}`; $('#fontStyle span').textContent = S.fontStyle;
  $('#fontSize').innerHTML = `<span></span>${ICON.chevDown}`; $('#fontSize span').textContent = String(S.fontSize);
  $('#fontDesc').textContent = `${S.fontFamily}, ${S.fontStyle}, ${S.fontSize}`;
  $('#wrapToggle').checked = S.wordWrap; $('#wrapLabel').textContent = S.wordWrap ? 'On' : 'Off';
  $('#statusToggle').checked = S.statusBar; $('#statusLabel').textContent = S.statusBar ? 'On' : 'Off';
}
function comboMenu(btn, values, current, onPick, fontPreview) {
  const r = btn.getBoundingClientRect();
  const idx = values.findIndex((v) => String(v) === String(current));
  const e = showMenu(values.map((v) => ({ label: String(v), checked: String(v) === String(current), font: fontPreview ? v : null, act: () => onPick(v) })),
    r.left, r.bottom + 2, { anchor: btn, selectedIdx: idx >= 0 ? idx : null, flipY: r.top - 2, restoreFocus: btn });
  e.el.style.minWidth = r.width + 'px';
}
$$('input[name="theme"]').forEach((r) => r.addEventListener('change', () => { S.theme = r.value; themeOverride = null; saveSettings(); applyAll(); }));
$('#fontFamily').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!fontList) { try { fontList = await invoke('list_fonts'); } catch { fontList = []; } }
  const base = ['Consolas', 'Cascadia Code', 'Cascadia Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono'];
  const all = [...new Set([...base.filter((f) => f === 'Consolas' || fontList.includes(f)), ...fontList])];
  comboMenu(btn, all, S.fontFamily, (v) => { S.fontFamily = v; saveSettings(); applyAll(); }, true);
});
$('#fontStyle').addEventListener('click', (e) => comboMenu(e.currentTarget, FONT_STYLES, S.fontStyle, (v) => { S.fontStyle = v; saveSettings(); applyAll(); }));
$('#fontSize').addEventListener('click', (e) => comboMenu(e.currentTarget, FONT_SIZES, S.fontSize, (v) => { S.fontSize = v; saveSettings(); applyAll(); }));
$('#wrapToggle').addEventListener('change', (e) => { S.wordWrap = e.target.checked; saveSettings(); applyAll(); });
$('#statusToggle').addEventListener('change', (e) => { S.statusBar = e.target.checked; saveSettings(); applyAll(); });
$$('.expander > .card-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
$('#settingsBtn').addEventListener('click', () => openSettings());
$('#settingsBack').addEventListener('click', () => closeSettings());

/* ---------------- window chrome ---------------- */
async function refreshMaxState() {
  let m = false;
  try { m = await appWindow.isMaximized(); } catch {}
  $('#app').classList.toggle('maximized', m);
  $('#btnMax').innerHTML = m ? ICON.restore : ICON.max;
  $('#btnMax').title = m ? 'Restore Down' : 'Maximize';
}
$('#btnMin').addEventListener('click', () => appWindow.minimize());
$('#btnMax').addEventListener('click', () => appWindow.toggleMaximize());
$('#btnClose').addEventListener('click', () => closeWindow());
$('#newTabBtn').addEventListener('click', () => newTab());
$$('.rz').forEach((h) => h.addEventListener('mousedown', (e) => {
  if (e.button === 0) { e.preventDefault(); appWindow.startResizeDragging(h.dataset.dir).catch(() => {}); }
}));
// double-click on an empty title-bar area toggles maximize (fallback if the drag region doesn't)
$('.drag-fill').addEventListener('dblclick', () => appWindow.toggleMaximize());
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

/* ---------------- keyboard shortcuts ---------------- */
document.addEventListener('keydown', (e) => {
  if (dialogOpen) return;
  if (handleMenuKey(e)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = e.ctrlKey || e.metaKey, sh = e.shiftKey, alt = e.altKey;
  const combo = (c ? 'C' : '') + (sh ? 'S' : '') + (alt ? 'A' : '') + '+' + k;
  const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  const inEditor = active && document.activeElement === active.ta;
  switch (combo) {
    case 'C+n': return run(() => newTab());
    case 'CS+n': return run(newWindow);
    case 'C+o': return run(openFile);
    case 'C+s': return run(() => saveTab(active));
    case 'CS+s': return run(() => saveTab(active, true));
    case 'CA+s': return run(saveAll);
    case 'C+w': return run(() => closeTab(active));
    case 'CS+w': return run(closeWindow);
    case 'C+p': return run(() => window.print());
    case 'C+f': return run(() => openFind(false));
    case 'C+h': return run(() => openFind(true));
    case 'C+g': return run(goToLine);
    case '+F3': return run(() => find(1));
    case 'S+F3': return run(() => find(-1));
    case '+F5': if (!settingsOpen) return run(insertTimeDate); return;
    case 'C+=': case 'C++': case 'CS++': case 'CS+=': return run(() => setZoom(zoom + 10));
    case 'C+-': case 'CS+_': case 'CS+-': return run(() => setZoom(zoom - 10));
    case 'C+0': return run(() => setZoom(100));
    case 'C+z': if (inEditor) return run(undo); return;
    case 'C+y': case 'CS+z': if (inEditor) return run(redo); return;
    case 'C+Tab': case 'C+PageDown': return run(() => activate(tabs[(tabs.indexOf(active) + 1) % tabs.length]));
    case 'CS+Tab': case 'C+PageUp': return run(() => activate(tabs[(tabs.indexOf(active) - 1 + tabs.length) % tabs.length]));
    case 'A+f': return run(() => { if (settingsOpen) closeSettings(); openMenubar('file', true); });
    case 'A+e': return run(() => { if (settingsOpen) closeSettings(); openMenubar('edit', true); });
    case 'A+v': return run(() => { if (settingsOpen) closeSettings(); openMenubar('view', true); });
    case 'A+F4': return run(closeWindow);
    case '+Escape':
      if (findOpen) return run(closeFind);
      if (settingsOpen) return run(() => closeSettings());
      return;
  }
  if (c && !sh && !alt && /^[1-9]$/.test(k)) {
    const n = +k; return run(() => activate(n === 9 ? tabs[tabs.length - 1] : tabs[n - 1] || active));
  }
}, true);
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

/* ---------------- init ---------------- */
function fillIcons() {
  $('#appIcon').innerHTML = ICON.app;
  $('#aboutIcon').innerHTML = ICON.app;
  $('#newTabBtn').innerHTML = ICON.plus;
  $('#btnMin').innerHTML = ICON.min;
  $('#btnMax').innerHTML = ICON.max;
  $('#btnClose').innerHTML = ICON.closeCap;
  $('#settingsBtn').innerHTML = ICON.gear;
  $('#settingsBack').innerHTML = ICON.back;
  $('#findToggle').innerHTML = ICON.chevDown;
  $('#findPrev').innerHTML = ICON.arrowUp;
  $('#findNext').innerHTML = ICON.arrowDown;
  $('#findOpts').innerHTML = ICON.options;
  $('#findClose').innerHTML = ICON.close10;
  $$('[data-icon]').forEach((n) => (n.innerHTML = ICON[n.dataset.icon] || ''));
}

(async function init() {
  fillIcons();
  applyTheme();
  applyEditorStyle();
  syncSettingsUI();
  refreshMaxState();
  appWindow.onResized(() => refreshMaxState()).catch(() => {});
  appWindow.onCloseRequested((ev) => { ev.preventDefault(); closeWindow(); }).catch(() => {});
  try {
    const wv = T.webview && T.webview.getCurrentWebview ? T.webview.getCurrentWebview() : appWindow;
    wv.onDragDropEvent(async (ev) => {
      if (ev.payload.type === 'drop') for (const p of ev.payload.paths || []) await openPath(p);
    });
  } catch {}
  let st = { files: [], theme: null, settings: false };
  try { st = await invoke('startup'); } catch {}
  if (st.theme && ['light', 'dark', 'system'].includes(st.theme)) { themeOverride = st.theme; applyTheme(); }
  for (const f of st.files || []) await openPath(f);
  if (!tabs.length) newTab();
  if (st.settings) openSettings();
})();
