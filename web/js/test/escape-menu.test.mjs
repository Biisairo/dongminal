import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, DIALOG, MENU, load } from './harness.mjs';

/**
 * REFACTOR3_FE_ESC_SRS — `EscapeStack` 두 층 · `Menu` · `Dialog` 의 Esc · 옮긴 처리기.
 *   TC-FEE-1 EscapeStack · TC-FEE-2 Menu · TC-FEE-3 Dialog·GitDialog · TC-FEE-4 소스 검사
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(JS, f), 'utf8');
const GIT = ['git/git-modal-base.js', 'git/git-confirm.js', 'git/git-dialog.js'];

function ev(key, extra) {
  return Object.assign({
    key, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }, extra || {});
}

// ── TC-FEE-1 EscapeStack ─────────────────────────────────────────────────

function stack() {
  const keys = [];
  const document = {
    addEventListener: (t, fn, cap) => { if (t === 'keydown') keys.push({ fn, cap: cap === true }) },
    removeEventListener() {},
  };
  const ctx = load(BASE, { expose: ['EscapeStack'], globals: { document } });
  return { S: ctx.EscapeStack, keys };
}

test('TC-FEE-1: 처음 넣을 때 문서에 캡처·버블 리스너를 하나씩 건다', () => {
  const { S, keys } = stack();
  S.push({ close() {} });
  S.push({ close() {} });
  assert.deepEqual(keys.map((k) => k.cap), [true, false]);
});

test('TC-FEE-1: 캡처 항목만 있으면 캡처 층이 닫고 전파를 끊는다', () => {
  const { S } = stack();
  const log = [];
  S.push({ close: () => log.push('a') });
  const e = ev('Escape');
  assert.equal(S.handle(e, 'bubble'), false, '버블 층은 캡처 항목을 건드리지 않는다');
  assert.equal(S.handle(e, 'capture'), true);
  assert.deepEqual(log, ['a']);
  assert.ok(e.defaultPrevented && e.stopped);
  assert.equal(S._items.length, 0);
});

test('TC-FEE-1: 버블 항목만 있으면 캡처는 아무것도 하지 않고 버블이 닫는다', () => {
  const { S } = stack();
  const log = [];
  S.push({ phase: 'bubble', close: () => log.push('b') });
  const e = ev('Escape');
  assert.equal(S.handle(e, 'capture'), false);
  assert.ok(!e.defaultPrevented && !e.stopped);
  assert.equal(S.handle(e, 'bubble'), true);
  assert.deepEqual(log, ['b']);
});

test('TC-FEE-1: 맨 위가 버블이고 아래가 캡처면 캡처 층은 아무것도 하지 않는다', () => {
  const { S } = stack();
  const log = [];
  S.push({ close: () => log.push('cap') });
  S.push({ phase: 'bubble', close: () => log.push('bub') });
  const e = ev('Escape');
  assert.equal(S.handle(e, 'capture'), false);
  assert.equal(S.handle(e, 'bubble'), true);
  assert.deepEqual(log, ['bub'], '한 번의 Esc 는 하나만 닫는다');
  assert.equal(S._items.length, 1);
});

test('TC-FEE-1: propagate 항목은 전파를 끊지 않는다', () => {
  const { S } = stack();
  S.push({ phase: 'bubble', propagate: true, close() {} });
  const e = ev('Escape');
  assert.equal(S.handle(e, 'bubble'), true);
  assert.ok(e.defaultPrevented);
  assert.ok(!e.stopped);
});

test('TC-FEE-1: active() 가 거짓인 맨 위는 건너뛰고 그 아래가 처리된다 — 죽은 항목은 남는다', () => {
  const { S } = stack();
  const log = [];
  const low = { close: () => log.push('low') };
  const dead = { active: () => false, close: () => log.push('dead') };
  S.push(low);
  S.push(dead);
  assert.equal(S.handle(ev('Escape'), 'capture'), true);
  assert.deepEqual(log, ['low']);
  assert.equal(S._items.length, 1, '건너뛴 항목은 남아 다시 살아나면 닫혀야 한다');
  assert.equal(S._items[0], dead);
});

test('TC-FEE-1: defaultPrevented 인 Esc 는 버블 층이 처리하지 않는다', () => {
  const { S } = stack();
  const log = [];
  S.push({ phase: 'bubble', close: () => log.push('b') });
  const e = ev('Escape', { defaultPrevented: true });
  assert.equal(S.handle(e, 'bubble'), false);
  assert.deepEqual(log, []);
  assert.equal(S._items.length, 1);
});

test('TC-FEE-1: Esc 가 아니면 아무것도 하지 않는다', () => {
  const { S } = stack();
  const log = [];
  S.push({ close: () => log.push('a') });
  S.push({ phase: 'bubble', close: () => log.push('b') });
  for (const ph of ['capture', 'bubble']) assert.equal(S.handle(ev('Enter'), ph), false);
  assert.deepEqual(log, []);
  assert.equal(S._items.length, 2);
});

// ── TC-FEE-2 Menu ────────────────────────────────────────────────────────

function mel(tag) {
  const e = {
    tagName: tag, className: '', dataset: {}, style: {}, children: [], attrs: {}, textContent: '', parentNode: null,
    listeners: {},
    appendChild(c) { e.children.push(c); c.parentNode = e; return c },
    removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; return c },
    setAttribute(k, v) { e.attrs[k] = String(v) },
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
    addEventListener(t, fn) { e.listeners[t] = fn },
    contains(x) { return x === e || e.children.some((c) => c.contains && c.contains(x)) },
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
  };
  return e;
}

function menuSetup() {
  const body = mel('body');
  const doc = [];
  const win = [];
  const document = {
    createElement: mel, body, activeElement: null,
    addEventListener: (t, fn, cap) => doc.push({ t, fn, cap }),
    removeEventListener: (t, fn) => { const i = doc.findIndex((x) => x.t === t && x.fn === fn); if (i >= 0) doc.splice(i, 1) },
  };
  const deferred = [];
  const ctx = load([...BASE, 'ui/ui-kit.js', ...MENU], {
    expose: ['UIKit', 'Menu', 'View', 'EscapeStack'],
    globals: {
      document, innerWidth: 1000, innerHeight: 1000,
      addEventListener: (t, fn) => win.push({ t, fn }),
      removeEventListener: (t, fn) => { const i = win.findIndex((x) => x.t === t && x.fn === fn); if (i >= 0) win.splice(i, 1) },
      TIMERS: { defer(fn) { deferred.push(fn) }, disposeOwner() {} },
      shortcuts: {},
      displayKey: (s) => s,
    },
  });
  return { ctx, body, doc, win, deferred };
}

test('TC-FEE-2: Menu 는 View 하위이고, UIKit.menu 가 Menu 를 지나 같은 마크업을 만든다', () => {
  const { ctx, body } = menuSetup();
  assert.ok(ctx.Menu.prototype instanceof ctx.View);
  const m = ctx.UIKit.menu([
    { id: 'a', label: 'A', onClick() {} },
    { sep: true },
    { id: 'b', label: 'B', disabled: 'why', danger: true },
  ], { cls: 'x', itemCls: 'old-item' });
  assert.equal(ctx.Menu._cur.el, m);
  assert.equal(ctx.UIKit._menu, m, 'UIKit._menu 입구');
  assert.equal(m.className, 'ui-menu ui-scroll-sm x');
  assert.equal(m.attrs.role, 'menu');
  assert.equal(m.parentNode, body);
  const [a, sep, b] = m.children;
  assert.equal(a.className, 'ui-menu-item old-item');
  assert.equal(a.attrs.role, 'menuitem');
  assert.equal(a.dataset.id, 'a');
  assert.equal(sep.attrs.role, 'separator');
  assert.equal(b.className, 'ui-menu-item old-item disabled danger');
  assert.equal(b.title, 'why');
  assert.equal(b.attrs['aria-disabled'], 'true');
  assert.equal(m.style.left, '4px');
});

test('TC-FEE-2: 열면 EscapeStack 캡처 층에 바로 들어가고 닫으면 빠진다 — 바깥 누름만 미룬다', () => {
  const { ctx, body, doc, win, deferred } = menuSetup();
  const S = ctx.EscapeStack;
  const before = doc.length;
  const m = ctx.UIKit.menu([{ id: 'a', label: 'A', onClick() {} }]);
  assert.equal(S._items.length, 1);
  assert.equal(S._items[0], ctx.Menu._cur);
  assert.ok(!doc.some((x) => x.t === 'mousedown'), '바깥 누름이 즉시 걸렸다');
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.ok(doc.some((x) => x.t === 'mousedown'));
  const e = ev('Escape');
  assert.equal(S.handle(e, 'capture'), true, '연 즉시 Esc 가 먹는다');
  assert.ok(e.defaultPrevented && e.stopped);
  assert.equal(m.parentNode, null);
  assert.equal(body.children.length, 0);
  assert.equal(ctx.Menu._cur, null);
  assert.equal(ctx.UIKit._menu, null);
  assert.equal(doc.length, before + 2, '메뉴 리스너가 남았다 — 남는 것은 EscapeStack 의 둘뿐이다');
  assert.equal(win.length, 0, '스크롤·크기 리스너가 남았다');
});

test('TC-FEE-2: 새 메뉴를 열면 앞 메뉴가 닫힌다 · closeMenu 는 입구다', () => {
  const { ctx, body } = menuSetup();
  const S = ctx.EscapeStack;
  const m1 = ctx.UIKit.menu([{ id: 'a', label: 'A' }]);
  const first = ctx.Menu._cur;
  const m2 = ctx.UIKit.menu([{ id: 'b', label: 'B' }]);
  assert.equal(m1.parentNode, null);
  assert.equal(m2.parentNode, body);
  assert.ok(!S._items.includes(first));
  assert.equal(S._items.length, 1);
  ctx.UIKit.closeMenu();
  assert.equal(m2.parentNode, null);
  assert.equal(S._items.length, 0);
  ctx.UIKit.closeMenu();
});

test('TC-FEE-2: 바깥 mousedown·스크롤은 메뉴 리스너가 닫는다', () => {
  const { ctx, doc, win, deferred } = menuSetup();
  const m = ctx.UIKit.menu([{ id: 'a', label: 'A' }]);
  deferred[0]();
  const md = doc.find((x) => x.t === 'mousedown');
  md.fn({ type: 'mousedown', target: m.children[0] });
  assert.ok(ctx.Menu._cur, '메뉴 안 누름으로 닫혔다');
  md.fn({ type: 'mousedown', target: {} });
  assert.equal(ctx.Menu._cur, null);
  ctx.UIKit.menu([{ id: 'a', label: 'A' }]);
  win.find((x) => x.t === 'scroll').fn({ type: 'scroll' });
  assert.equal(ctx.Menu._cur, null);
});

// ── TC-FEE-3 Dialog ──────────────────────────────────────────────────────

function dialogSetup() {
  const node = () => ({ children: [], parentNode: null, appendChild(c) { this.children.push(c); c.parentNode = this; return c }, remove() { this.parentNode = null } });
  const document = { activeElement: null, body: node(), addEventListener() {}, removeEventListener() {} };
  const UIKit = { _dlgStack: [], dialogOpen: () => () => {} };
  const ctx = load([...BASE, ...DIALOG.slice(0, 1), ...GIT], {
    expose: ['Dialog', 'GitConfirm', 'GitDialog', 'EscapeStack'],
    globals: { document, UIKit, TIMERS: { disposeOwner() {}, frame() {} }, ClipboardWriter: { write() {} } },
  });
  const Probe = class extends ctx.Dialog {
    _build() { this.ov = node(); this.box = node(); document.body.appendChild(this.ov) }
    _paint() {}
    _focus() {}
  };
  return { ctx, Probe, S: ctx.EscapeStack };
}

test('TC-FEE-3: Dialog 는 열면 EscapeStack 에 들어가고 닫으면 빠진다 — Esc 는 _escape → _dismiss', async () => {
  const { Probe, S } = dialogSetup();
  const d = new Probe();
  const p = d._show();
  assert.equal(S._items.length, 1);
  assert.equal(S._items[0].phase, 'capture');
  assert.ok(!S._items[0].propagate);
  d._close(true);
  assert.equal(await p, true);
  assert.equal(S._items.length, 0);

  const d2 = new Probe();
  d2._show();
  const e = ev('Escape');
  assert.equal(S.handle(e, 'capture'), true);
  assert.ok(e.defaultPrevented && e.stopped);
  assert.equal(d2.ov, null, '기본 _escape 는 _dismiss(=_close) 다');
  assert.equal(S._items.length, 0);
});

test('TC-FEE-3: 층은 _escCapture 를 따른다 — 버블이면 전파를 끊지 않는다', () => {
  const { Probe, S } = dialogSetup();
  const d = new Probe();
  d._escCapture = false;
  d._show();
  assert.equal(S._items[0].phase, 'bubble');
  assert.equal(S._items[0].propagate, true);
  assert.equal(S.handle(ev('Escape'), 'capture'), false);
});

test('TC-FEE-3: 맨 위 것만 닫힌다 — 위에 연 대화상자가 먼저다', () => {
  const { Probe, S } = dialogSetup();
  const a = new Probe(), b = new Probe();
  a._show();
  b._show();
  S.handle(ev('Escape'), 'capture');
  assert.equal(b.ov, null);
  assert.ok(a.ov, '아래 것도 닫혔다');
  S.handle(ev('Escape'), 'capture');
  assert.equal(a.ov, null);
});

test('TC-FEE-3: GitDialog 의 Esc 는 _cancel 이고 busy 면 부르지 않는다', () => {
  const { ctx } = dialogSetup();
  const d = Object.create(ctx.GitDialog.prototype);
  let n = 0;
  d._cancel = () => { n++ };
  d.busy = true;
  d._escape();
  assert.equal(n, 0);
  d.busy = false;
  d._escape();
  assert.equal(n, 1);
  assert.doesNotMatch(read('git/git-dialog.js'), /'Escape'/, 'GitDialog._onKey 에 Esc 가 남았다');
});

test('TC-FEE-3: 실행 중이라 닫지 않은 대화상자는 스택에 남는다', () => {
  const { Probe, S } = dialogSetup();
  const d = new Probe();
  d._show();
  d._escape = () => {};
  assert.equal(S.handle(ev('Escape'), 'capture'), true);
  assert.equal(S._items.length, 1, '닫지 않았는데 빠졌다');
  d._close();
  assert.equal(S._items.length, 0);
});

test('TC-FEE-3: GitConfirm 은 busy 면 취소하지 않는다', () => {
  const { ctx } = dialogSetup();
  const d = Object.create(ctx.GitConfirm.prototype);
  let n = 0;
  d._cancel = () => { n++ };
  d.busy = true;
  d._escape();
  d.busy = false;
  d._escape();
  assert.equal(n, 1);
});

// ── TC-FEE-4 소스 검사 ───────────────────────────────────────────────────

test('TC-FEE-4: 옮긴 처리기 셋에 문서 keydown 리스너가 없다', () => {
  for (const f of ['core/app-mobile-sheets.js', 'core/app-claude-accounts.js', 'ui/file-tree-xfer.js']) {
    assert.doesNotMatch(read(f), /document\.addEventListener\('keydown'/, f);
  }
});

test('TC-FEE-4: #settings-btn 에 click 을 거는 자리는 settings-modal.js 하나다', () => {
  const files = ['core/settings-modal.js', 'core/app-settings.js', 'core/app-settings-profile.js', 'core/app-mobile-sheets.js'];
  const hits = files.filter((f) => /getElementById\('settings-btn'\)[^;\n]*\.addEventListener\('click'|const (\w+)=document\.getElementById\('settings-btn'\);[\s\S]{0,40}\1\.addEventListener\('click'/.test(read(f)));
  assert.deepEqual(hits, ['core/settings-modal.js']);
});
