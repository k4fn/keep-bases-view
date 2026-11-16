const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function harness() {
  const dom = new JSDOM('<body><div id="scroll"></div></body>');
  const { window } = dom;
  const frames = [];
  const proto = window.HTMLElement.prototype;
  proto.addClass = function (...names) { this.classList.add(...names); };
  proto.removeClass = function (...names) { this.classList.remove(...names); };
  proto.empty = function () { this.replaceChildren(); };
  proto.createEl = function (tag, options = {}) {
    const el = window.document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    if (options.type) el.type = options.type;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (o) { return this.createEl('div', o); };
  proto.createSpan = function (o) { return this.createEl('span', o); };
  // jsdom has no layout engine. Deterministic geometry tests the state machine;
  // actual pixel heights and timings must be checked in Obsidian.
  proto.getBoundingClientRect = function () {
    const height = this.classList.contains('kg-card') ? 60 + (this.querySelectorAll('.kg-lite-line').length * 20) : 0;
    return { width: 1000, height, top: 0, bottom: height, left: 0, right: 1000 };
  };
  Object.defineProperty(proto, 'offsetTop', { get() {
    if (!this.classList.contains('kg-virtual-grid')) return 0;
    let top = 24;
    for (const section of this.parentElement.parentElement.children) {
      if (section === this.parentElement) break;
      top += Number.parseFloat(section.querySelector('.kg-virtual-grid')?.style.height || 0) + 56;
    }
    return top;
  } });
  class TFile {
    constructor(path) { this.path = path; this.name = path; this.basename = path.split('.')[0]; this.extension = path.split('.').at(-1); this.stat = { mtime: 1, size: 10 }; }
  }
  const files = new Map(), contents = new Map(), metadata = new Map();
  let reads = 0;
  const app = {
    metadataCache: { getFileCache: f => metadata.get(f.path) ?? {}, getFirstLinkpathDest: p => files.get(p) },
    vault: { getAbstractFileByPath: p => files.get(p), getResourcePath: f => `resource:${f.path}`,
      cachedRead: async f => { reads++; const text = contents.get(f.path); if (text instanceof Error) throw text; return text ?? 'body'; } },
    workspace: { trigger() {} },
  };
  const obsidian = {
    BasesView: class { constructor() { this.app = app; } }, Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {},
    TFile, NullValue: class {}, Platform: { isMobile: false }, normalizePath: x => x,
    debounce: fn => Object.assign(fn, { cancel() {} }), setIcon: (el, icon) => el.createSpan({ text: icon }),
    Keymap: { isModEvent: () => false },
  };
  const context = vm.createContext({ require: () => obsidian, module: { exports: {} }, window,
    document: window.document, Element: window.Element, getComputedStyle: window.getComputedStyle.bind(window),
    performance, console, setTimeout, clearTimeout, queueMicrotask, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: fn => frames.push(fn), Image: class {},
  });
  vm.runInContext(fs.readFileSync('main.js', 'utf8') + '\nglobalThis.API = { KeepGridView, KeepBasesViewPlugin, extractBodyMarkdownInfo, extractBodyMarkdown, lruSet };', context);
  const plugin = Object.assign(new context.API.KeepBasesViewPlugin(), {
    settings: {}, _views: new Set(), _cssGeneration: 0, _cardLayoutCache: new Map(), _previewSourceCache: new Map(),
    _imageDimensionCache: new Map(), _inFlightImageProbes: new Map(), _imageProbeQueue: [], _activeImageProbes: 0, _maxConcurrentImageProbes: 8,
  });
  const scroll = window.document.getElementById('scroll');
  Object.defineProperty(scroll, 'clientHeight', { value: 600 });
  Object.defineProperty(scroll, 'scrollHeight', { value: 1000000 });
  const view = new context.API.KeepGridView({}, scroll, plugin);
  view.data = { properties: [], data: [] };
  view._previewImages = true;
  function entries(count, prefix = 'note') {
    return Array.from({ length: count }, (_, i) => {
      const file = new TFile(`${prefix}${i}.md`); files.set(file.path, file);
      return { file, getValue: () => '' };
    });
  }
  async function settle() {
    for (let i = 0; i < 1000; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const frame = frames.splice(0); frame.forEach(fn => fn());
      if (!frames.length && !view._batchRun) return;
    }
    throw Error('View did not settle');
  }
  return { ...context.API, context, plugin, view, files, contents, metadata, entries, settle, frames, window, reads: () => reads };
}

test('bounded extraction matches existing preview semantics', () => {
  const h = harness();
  for (const body of ['', 'one', 'a\nb\nc\n', '---\ntitle: x\n---\n\nbody', 'x'.repeat(100000)]) {
    let legacy = body;
    if (legacy.startsWith('---')) { const end = legacy.indexOf('\n---', 3); if (end !== -1) legacy = legacy.slice(end + 4).trimStart(); }
    const lines = legacy.split('\n'), kept = lines.slice(0, 2).join('\n');
    const expected = { markdown: kept.slice(0, 5).trim() || null, truncated: lines.length > 2 || kept.length > 5 };
    assert.deepEqual(JSON.parse(JSON.stringify(h.extractBodyMarkdownInfo(body, 2, 5))), expected);
  }
});

test('strict prefix, pinned dependency, isolated read failure, stable positions', async () => {
  const h = harness(), entries = h.entries(240);
  h.metadata.set(entries[0].file.path, { frontmatter: { keep_pinned: true } });
  h.contents.set(entries[1].file.path, Error('unreadable'));
  h.view._renderToken = 1;
  h.view._renderVirtual(entries, 1, 0, false);
  await h.settle();
  const v = h.view._virtual;
  assert.equal(v.sections[0].measuredPrefixEnd, 0);
  const failed = v.sections[1].items[0];
  assert.equal(failed.measured, true);
  assert.equal(failed.readFailed, true);
  assert.equal(h.plugin._cardLayoutCache.has(h.view._layoutCacheKey(failed)), false);
  const positions = new Map([...v.mounted].map(([key, card]) => [key, card.style.transform]));
  const sameItem = v.sections[1].items[1];
  h.plugin._cardLayoutCache.clear();
  h.view._scrollEl.scrollTop = 2500;
  h.view._renderVirtualWindow();
  await h.settle();
  h.view._scrollEl.scrollTop = 0; h.view._renderVirtualWindow();
  assert.equal(v.sections[1].items[1], sameItem);
  for (const [key, transform] of positions) if (v.mounted.has(key)) assert.equal(v.mounted.get(key).style.transform, transform);
  for (const section of v.sections) for (const card of section.gridEl.children) assert.ok(card._kgVirtualItem.index <= section.measuredPrefixEnd);
  assert.equal(h.view._measureEl.childElementCount, 0);
});

test('warm restoration needs no file reads or measurement', async () => {
  const h = harness(), entries = h.entries(200);
  h.view._renderToken = 1; h.view._renderVirtual(entries, 1, 1800, true); await h.settle();
  const reads = h.reads();
  h.view._contentEl.empty(); h.view._renderToken = 2;
  h.view._renderVirtual(entries, 2, 1800, true); await h.settle();
  assert.equal(h.reads(), reads);
  assert.equal(h.view._virtual.restoring, false);
  assert.equal(h.view._scrollEl.scrollTop, 1800);
});

test('expired image failures stay frozen until a new render; missing local images invalidate', async () => {
  const h = harness(), entries = h.entries(2);
  h.contents.set(entries[0].file.path, '![](missing.png)');
  await h.plugin._probeImageDimensions({ imageCacheKey: 'missing:missing.png', src: null });
  h.view._renderToken = 1; h.view._renderVirtual(entries, 1, 0, false); await h.settle();
  const item = h.view._virtual.sections[0].items[0];
  assert.equal(item.imageLocks[0].status, 'failed');
  item.expiresAt = Date.now() - 1;
  const height = item.height;
  h.view._renderVirtualWindow(); await h.settle();
  assert.equal(item.height, height); assert.equal(item.measured, true);
  const image = entries[1].file; h.files.set('missing.png', image);
  assert.equal(h.view._isImageLocksValid(item.imageLocks, item.entry.file.path), false);
});

test('epoch changes abort asynchronous measurement without committing stale heights', async () => {
  const h = harness(), entries = h.entries(5);
  let release;
  h.view._getPreviewSource = () => new Promise(resolve => { release = resolve; });
  h.view._renderToken = 1; h.view._renderVirtual(entries.slice(0, 1), 1, 0, false);
  h.view._layoutEpoch++; release({ markdown: 'old body' }); await h.view._batchRun;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.view._virtual.sections[0].items[0].measured, false);
  assert.equal(h.plugin._cardLayoutCache.size, 0);
  h.view.onClose();
});

test('image probes share in-flight work, respect concurrency and cache success/failure', async () => {
  const h = harness(), pending = [];
  h.context.Image = class {
    constructor() { this.naturalWidth = 400; this.naturalHeight = 800; }
    set src(src) { if (src) pending.push(this); }
  };
  const spec = { imageCacheKey: 'url:one', src: 'https://one' };
  const a = h.plugin._probeImageDimensions(spec), b = h.plugin._probeImageDimensions(spec);
  assert.equal(a, b);
  const more = Array.from({ length: 20 }, (_, i) => h.plugin._probeImageDimensions({ imageCacheKey: `url:${i}`, src: `https://${i}` }));
  assert.equal(h.plugin._activeImageProbes, 8);
  while (pending.length) pending.shift().onload();
  await Promise.all([a, ...more]);
  assert.equal(h.plugin._activeImageProbes, 0);
  assert.equal((await h.plugin._probeImageDimensions(spec)).naturalHeight, 800);
  const failed = await h.plugin._probeImageDimensions({ imageCacheKey: 'missing:x', src: null });
  assert.equal(failed.status, 'failed'); assert.ok(failed.expiresAt > Date.now());
  assert.equal(h.plugin._inFlightImageProbes.size, 0);
});

test('LRU evicts oldest access and keeps the requested bound', () => {
  const h = harness(), cache = new Map();
  h.lruSet(cache, 'a', 1, 2); h.lruSet(cache, 'b', 2, 2); h.lruSet(cache, 'a', 3, 2); h.lruSet(cache, 'c', 4, 2);
  assert.deepEqual([...cache.keys()], ['a', 'c']);
});

test('more than 10,000 measured items retain heights after all layout cache entries are evicted', async () => {
  const h = harness(), entries = h.entries(10020);
  h.view._renderToken = 1;
  h.view._renderVirtual(entries.slice(0, 1), 1, 0, false); await h.settle();
  const section = h.view._virtual.sections[0], template = section.items[0];
  section.entries = entries;
  section.items = entries.map((entry, index) => ({ ...template, entry, index,
    key: `0:${entry.file.path}`, measured: true, height: 77 + (index % 5), mountedEl: null, preparedEl: null }));
  h.plugin._cardLayoutCache.clear();
  const identity = section.items;
  h.view._layoutVirtualSections();
  assert.equal(section.items, identity);
  assert.equal(section.measuredPrefixEnd, 10019);
  for (const item of section.items) assert.equal(item.height, 77 + (item.index % 5));
});

test('timeout failures are shared without waiting again, then retried after TTL', async () => {
  const h = harness(), timers = [];
  let images = 0;
  h.context.setTimeout = fn => { timers.push(fn); return timers.length; };
  h.context.clearTimeout = () => {};
  h.context.Image = class {
    constructor() { images++; }
    set src(value) { this.value = value; }
  };
  const spec = { imageCacheKey: 'url:timeout', src: 'https://timeout' };
  const first = h.plugin._probeImageDimensions(spec);
  timers.shift()();
  const result = await first;
  assert.equal(result.status, 'failed');
  assert.equal(await h.plugin._probeImageDimensions(spec), result);
  assert.equal(images, 1);
  result.expiresAt = Date.now() - 1;
  const retry = h.plugin._probeImageDimensions(spec);
  assert.equal(images, 2); timers.shift()(); await retry;
});

test('known image dimensions reserve natural aspect ratio and failed images never create img elements', () => {
  const h = harness(), body = h.window.document.createElement('div');
  h.view._renderPreviewImage(body, { src: 'https://portrait', naturalWidth: 400, naturalHeight: 900, status: 'ok' });
  assert.equal(body.firstChild.style.aspectRatio, '400 / 900');
  h.view._renderPreviewImage(body, { src: 'https://timeout', label: 'timeout', status: 'failed' });
  assert.equal(body.lastChild.querySelector('img'), null);
  assert.ok(body.lastChild.querySelector('.kg-lite-image-missing'));
});

test('delegated click/context actions remain active while scrolling; stationary pointer restores hover buttons', async () => {
  const h = harness(), entries = h.entries(3);
  h.view._renderToken = 1; h.view._renderVirtual(entries, 1, 0, false); await h.settle();
  const card = [...h.view._virtual.mounted.values()][0];
  assert.equal(card.querySelector('button'), null);
  let clicks = 0, contexts = 0;
  card._kgHandlers.click = () => clicks++;
  card._kgHandlers.contextmenu = () => contexts++;
  h.view._onScroll();
  card.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  card.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true }));
  card.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(clicks, 1); assert.equal(contexts, 1);
  assert.equal(card.querySelector('button'), null);
  h.window.document.elementFromPoint = () => card;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(card.querySelectorAll('button').length, 3);
  let pins = 0;
  card._kgActions.pin = () => pins++;
  card.querySelector('.kg-pin-btn').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(pins, 1); assert.equal(clicks, 1);
  h.view.onClose();
});

test('all image vault events and CSS changes invalidate open views', async () => {
  const h = harness(), handlers = new Map();
  const app = h.view.app;
  app.workspace.on = (event, handler) => { handlers.set(event, handler); };
  app.workspace.onLayoutReady = fn => fn();
  app.vault.on = (event, handler) => { handlers.set(event, handler); };
  Object.assign(h.plugin, { app, loadSettings: async () => {}, registerEvent() {}, addSettingTab() {},
    registerHoverLinkSource() {}, registerBasesView() {}, addCommand() {} });
  await h.plugin.onload();
  let refreshed = 0;
  h.plugin._views.add({ _renderSignature: 'old', _debouncedRender: () => refreshed++ });
  for (const event of ['create', 'modify', 'delete', 'rename']) handlers.get(event)({ path: 'image.png' });
  assert.equal(refreshed, 4);
  handlers.get('rename')({ path: 'new.txt' }, 'old.png');
  assert.equal(refreshed, 5);
  handlers.get('css-change')();
  assert.equal(h.plugin._cssGeneration, 1); assert.equal(refreshed, 6);
});

function zeroWhenNotRendered(h, hidden = () => false) {
  const proto = h.window.HTMLElement.prototype, rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    if (!this.isConnected || hidden(this)) return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
    return rect.call(this);
  };
}

test('onunload tears the view down but keeps a scroll position saved for navigating back', async () => {
  const h = harness(), entries = h.entries(80);
  h.plugin._scrollPositions = new Map();
  h.view._renderToken = 1; h.view._renderVirtual(entries, 1, 0, false); await h.settle();
  h.view._scrollEl.scrollTop = 1200;
  h.view._saveScrollPosition(null, true);
  assert.equal(h.plugin._views.has(h.view), true);
  h.view.onunload();
  assert.equal(h.plugin._views.has(h.view), false);
  assert.equal(h.view._virtual, null);
  assert.equal(h.plugin._scrollPositions.size, 1);
  h.view._scrollEl.dispatchEvent(new h.window.Event('scroll'));
  assert.equal(h.frames.length, 0);
  h.view.onunload();
  assert.equal(h.plugin._scrollPositions.size, 1);
  h.view.onClose();
  assert.equal(h.plugin._scrollPositions.size, 0);
});

test('a view whose container was cleared stops measuring and never caches 0px heights', async () => {
  const h = harness(), entries = h.entries(200);
  zeroWhenNotRendered(h);
  h.view._renderToken = 1; h.view._renderVirtual(entries, 1, 0, false); await h.settle();
  h.plugin._cardLayoutCache.clear();
  const measuredBefore = h.view._virtual.sections[0].measuredPrefixEnd;
  h.view._scrollEl.replaceChildren();
  h.view._scrollEl.scrollTop = 3000;
  h.view._renderVirtualWindow(); await h.settle();
  assert.equal(h.plugin._cardLayoutCache.size, 0);
  assert.equal(h.view._virtual.sections[0].measuredPrefixEnd, measuredBefore);
  assert.equal(h.frames.length, 0);
});

test('a measuring box that is not rendered pauses measurement and resumes later', async () => {
  const h = harness(), entries = h.entries(60);
  let hidden = true;
  zeroWhenNotRendered(h, el => hidden && el.closest?.('.kg-measure'));
  h.view._renderToken = 1; h.view._renderVirtual(entries, 1, 0, false); await h.settle();
  assert.equal(h.plugin._cardLayoutCache.size, 0);
  assert.equal(h.view._virtual.sections[0].items.some(item => item.measured), false);
  assert.equal(h.frames.length, 0);
  hidden = false;
  h.view._renderVirtualWindow(); await h.settle();
  const measured = h.view._virtual.sections[0].items.filter(item => item.measured);
  assert.ok(measured.length > 0);
  assert.ok(measured.every(item => item.height > 1));
  h.view.onClose();
});

// Keep-style checklists. \u001f starts a row that the extraction adds:
// H header, G ghost parent, C completed row, M the "+ N ticked items" line.
const R = '\u001f';
const checklist = checked => ['A', ' A1', ' A2', 'B', ' B1', ' B2', ' B3', 'C', ' C1', '  C1a', '  C1b', ' C2', 'D', ' D1']
  .map(name => `${'\t'.repeat(name.length - name.trimStart().length)}- [${checked.includes(name.trim()) ? 'x' : ' '}] ${name.trim()}`).join('\n');
const card = (h, body, mode = 'full', lines = 25) => h.extractBodyMarkdownInfo(body, lines, 1000, mode).markdown.split('\n');
const names = rows => rows.map(row => row.replace(/^(\u001f.)?\s*- (\[.\] )?/, (_, kind, box) => `${kind?.[1] ?? ''}${box === '[x] ' ? 'x' : ''}:`));

test('checklists: completed items follow the list under ghost parents', () => {
  const h = harness();
  // A subtree and B2 checked.
  assert.deepEqual(names(card(h, checklist(['A', 'A1', 'A2', 'B2']))), [':B', ':B1', ':B3', ':C', ':C1', ':C1a', ':C1b', ':C2', ':D', ':D1',
    `${R}H4 Completed items`, 'Cx:A', 'Cx:A1', 'Cx:A2', 'G:B', 'Cx:B2']);
  // All children of B checked, B stays on top.
  assert.deepEqual(names(card(h, checklist(['B1', 'B2', 'B3']))).slice(0, 3), [':A', ':A1', ':A2']);
  assert.deepEqual(names(card(h, checklist(['B1', 'B2', 'B3']))).slice(11), [`${R}H3 Completed items`, 'G:B', 'Cx:B1', 'Cx:B2', 'Cx:B3']);
  // One ghost C shared, ghost chain for the third level.
  assert.deepEqual(names(card(h, checklist(['C1a', 'C2']))).slice(12), [`${R}H2 Completed items`, 'G:C', 'G:C1', 'Cx:C1a', 'Cx:C2']);
  // A checked item with an unchecked item below it stays on top.
  assert.deepEqual(card(h, checklist(['D'])), checklist(['D']).split('\n'));
  // Rows keep their indentation; any status character counts as checked.
  assert.deepEqual(card(h, '- [ ] B\n\t- [/] B2'), ['- [ ] B', `${R}H1 Completed item`, `${R}G- [ ] B`, `${R}C\t- [x] B2`]);
});

test('checklists: plain items, content, several lists, text around lists', () => {
  const h = harness();
  assert.deepEqual(card(h, '- Groceries\n\t- [ ] Milk\n\t- [x] Bread'),
    ['- Groceries', '\t- [ ] Milk', `${R}H1 Completed item`, `${R}G- Groceries`, `${R}C\t- [x] Bread`]);
  // A plain item and wrapped text under a checked item go with it.
  assert.deepEqual(card(h, '- [x] Done\n  more\n\t- note\n- [ ] Open'), ['- [ ] Open', `${R}H1 Completed item`, `${R}C- [x] Done`, `${R}C\t- note`]);
  // Each list has its own section, directly after it.
  assert.deepEqual(card(h, 'Intro\n- [x] a\n- [ ] b\n\nText\n\n- [x] c\n- [ ] d\nEnd'),
    ['Intro', '- [ ] b', `${R}H1 Completed item`, `${R}C- [x] a`, '', 'Text', '', '- [ ] d', `${R}H1 Completed item`, `${R}C- [x] c`, 'End']);
  // Frontmatter, code blocks and blockquotes are left alone.
  const untouched = '```\n- [x] code\n```\n> - [x] quoted\n> - [ ] quoted';
  assert.deepEqual(card(h, `---\ntitle: x\n---\n${untouched}`), untouched.split('\n'));
});

test('checklists: phones leave completed items out', () => {
  const h = harness();
  assert.deepEqual(names(card(h, checklist(['A', 'A1', 'A2', 'B2']), 'open')), [':B', ':B1', ':B3', ':C', ':C1', ':C1a', ':C1b', ':C2', ':D', ':D1', `${R}M+ 4 ticked items`]);
  assert.deepEqual(card(h, 'Text\n- [x] a\n\t- [x] b\nEnd', 'open'), ['Text', `${R}M+ 2 ticked items`, 'End']);
});

test('checklists: the line limit applies after completed items have left their place', () => {
  const h = harness();
  const body = Array.from({ length: 60 }, (_, i) => `- [${i < 50 ? 'x' : ' '}] item ${i}`).join('\n');
  const info = h.extractBodyMarkdownInfo(body, 25, 1000, 'full'), rows = info.markdown.split('\n');
  assert.deepEqual(rows.slice(0, 12), [...Array.from({ length: 10 }, (_, i) => `- [ ] item ${50 + i}`), `${R}H50 Completed items`, `${R}C- [x] item 0`]);
  assert.equal(rows.length, 25); assert.equal(info.truncated, true);
});

test('checklists: off, and notes without checked items, are extracted as before', () => {
  const h = harness();
  for (const body of [checklist(['A', 'B2']), '- [ ] a\n- [ ] b', 'text [x] text', '---\ntitle: x\n---\n\n- [x] a']) {
    assert.equal(JSON.stringify(h.extractBodyMarkdownInfo(body, 25, 1000, '')), JSON.stringify(h.extractBodyMarkdownInfo(body, 25, 1000)));
    assert.equal(h.view._parsePreviewBlocks(h.extractBodyMarkdown(body)).filter(block => block.row || block.type === 'completed').length, 0);
  }
  for (const mode of ['full', 'open']) assert.equal(JSON.stringify(h.extractBodyMarkdownInfo('- [ ] a\n- [ ] b\ntext [x]', 25, 1000, mode)), JSON.stringify(h.extractBodyMarkdownInfo('- [ ] a\n- [ ] b\ntext [x]')));
});

test('checklists: card rows, and the card line limit', async () => {
  const h = harness(), [entry] = h.entries(1);
  h.contents.set(entry.file.path, checklist(['A', 'A1', 'A2', 'B2', 'C', 'C1', 'C1a', 'C1b', 'C2']));
  h.plugin.settings.keepChecklists = true;
  h.view._cardMaxHeight = 200; // 10 lines
  h.view._renderToken = 1; h.view._renderVirtual([entry], 1, 0, false); await h.settle();
  const rows = () => [...h.view._virtual.mounted.values()][0]._keepBodyEl.children;
  const describe = row => `${row.className.replace(/kg-lite-/g, '')}|${row.querySelector('input')?.checked ?? ''}|${row.textContent}|${row.style.marginLeft}`;
  assert.deepEqual([...rows()].map(describe), [
    'task|false|B|', 'task|false|B1|20px', 'task|false|B3|20px', 'task|false|D|', 'task|false|D1|20px',
    'completed||9 Completed items|', 'task done|true|A|', 'task done|true|A1|20px', 'task done|true|A2|20px',
    'task ghost|false|B|']);
  assert.equal([...h.view._virtual.mounted.values()][0]._keepBodyEl.dataset.keepTruncated, 'true');
});

test('checklists: changing the setting or the device class re-measures the cards', async () => {
  const h = harness(), [entry] = h.entries(1);
  h.contents.set(entry.file.path, '- [x] a\n- [ ] b');
  const render = async token => { h.view._contentEl?.empty(); h.view._renderToken = token; h.view._renderVirtual([entry], token, 0, false); await h.settle(); };
  const shown = () => [...[...h.view._virtual.mounted.values()][0]._keepBodyEl.children].map(row => row.textContent);
  // Off by default.
  await render(1);
  assert.deepEqual(shown(), ['a', 'b']);
  h.plugin.settings.keepChecklists = true;
  await render(1.5);
  const signature = h.view._getRenderSignature([entry]), key = h.view._layoutConfigKey;
  assert.deepEqual(shown(), ['b', '1 Completed item', 'a']);
  h.plugin.settings.keepChecklists = false;
  assert.notEqual(h.view._getRenderSignature([entry]), signature);
  await render(2);
  assert.notEqual(h.view._layoutConfigKey, key);
  assert.deepEqual(shown(), ['a', 'b']);
  h.plugin.settings.keepChecklists = true; h.window.document.body.classList.add('is-phone');
  await render(3);
  assert.deepEqual(shown(), ['b', '+ 1 ticked item']);
  h.window.document.body.classList.remove('is-phone');
  const reads = h.reads();
  await render(4);
  assert.deepEqual(shown(), ['b', '1 Completed item', 'a']);
  assert.equal(h.reads(), reads);
});
