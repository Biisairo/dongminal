import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, DIALOG, load } from './harness.mjs';

/**
 * REFACTOR3_FE_DIALOG_SRS — 대화상자 기반 클래스 `Dialog` 와 그 하위.
 *   TC-FED-1~3 Dialog · TC-FED-4 Git 모달 · TC-FED-5 KitModal · TC-FED-6 SettingsModal · TC-FED-7 정적
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(JS, f), 'utf8');
const GIT = ['git/git-modal-base.js', 'git/git-confirm.js', 'git/git-dialog.js'];

// ── 최소 DOM ─────────────────────────────────────────────────────────────
// 선택자는 `.cls` 하나뿐이다.

function el(tag, cls) {
  const classes = new Set();
  const e = {
    tagName: tag, children: [], parentNode: null, hidden: false, dataset: {}, attrs: {}, listeners: {},
    isConnected: true,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on },
    },
    get className() { return [...classes].join(' ') },
    set className(v) { classes.clear(); for (const c of String(v).split(' ').filter(Boolean)) classes.add(c) },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c },
    removeChild(c) { const a = this.children; a.splice(a.indexOf(c), 1); c.parentNode = null; return c },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    addEventListener(t, fn) { this.listeners[t] = fn },
    removeEventListener(t, fn) { if (this.listeners[t] === fn) delete this.listeners[t] },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    querySelectorAll(sel) {
      const c = sel.replace(/^\./, ''), out = [];
      const walk = (n) => { for (const k of n.children) { if (k.classList.contains(c)) out.push(k); walk(k) } };
      walk(this);
      return out;
    },
    focus() {},
  };
  e.className = cls || '';
  return e;
}

function env(ids) {
  const log = [];
  const keys = [];
  const stack = [];
  const document = {
    activeElement: null,
    body: el('body'),
    createElement: (tag) => el(tag),
    getElementById: (id) => (ids && ids[id]) || null,
    addEventListener: (t, fn, cap) => { if (t === 'keydown') keys.push({ fn, cap: cap === true }) },
    removeEventListener: (_t, fn, cap) => {
      const i = keys.findIndex((k) => k.fn === fn && k.cap === (cap === true));
      if (i >= 0) keys.splice(i, 1);
    },
  };
  const UIKit = {
    _dlgStack: stack,
    dialogOpen(box, spec) {
      log.push('dialogOpen');
      const entry = { box, spec };
      stack.push(entry);
      return () => { log.push('release'); const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1) };
    },
    fadeWatch() { log.push('fade'); return () => log.push('unfade') },
  };
  const TIMERS = { disposeOwner() {}, frame() {} };
  return { log, keys, stack, document, UIKit, TIMERS };
}

function loadDialog(e, extra = [], expose = []) {
  return load([...BASE, 'ui/dialog.js', ...extra], {
    expose: ['Dialog', 'EscapeStack', ...expose],
    globals: { document: e.document, UIKit: e.UIKit, TIMERS: e.TIMERS, ClipboardWriter: { write() {} } },
  });
}

function probeClass(ctx, e) {
  return class extends ctx.Dialog {
    _build() {
      e.log.push('build:' + (e.document.activeElement && e.document.activeElement.id));
      this.ov = el('div'); this.box = el('div');
      this.ov.appendChild(this.box);
      e.document.body.appendChild(this.ov);
      e.document.activeElement = { id: 'inside' };
    }
    _beforePaint() { e.log.push('before') }
    _paint() { e.log.push('paint') }
    _focus() { e.log.push('focus') }
  };
}

const key = (k) => ({ key: k, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } });

test('TC-FED-1 _show 는 포커스를 먼저 잡고 build→beforePaint→paint→focus→dialogOpen 순으로 연다', async () => {
  const e = env();
  const ctx = loadDialog(e);
  const T = probeClass(ctx, e);
  e.document.activeElement = { id: 'opener' };
  const d = new T();
  d.title = 'T';
  const p = d._show();
  assert.deepEqual(e.log, ['build:opener', 'before', 'paint', 'focus', 'dialogOpen']);
  const spec = e.stack[0].spec;
  assert.equal(spec.returnTo.id, 'opener', '돌아갈 자리는 build 전의 포커스다');
  assert.equal(spec.focus.id, 'inside');
  assert.equal(spec.label, 'T');
  d._close(1);
  assert.equal(await p, true, '_result 의 기본은 boolean 이다');
});

test('TC-FED-2 _close 는 한 번만 돌고, 닫으면 키 수신기와 오버레이가 사라진다', async () => {
  const e = env();
  const ctx = loadDialog(e);
  const d = new (probeClass(ctx, e))();
  const p = d._show();
  // 자기 키 수신기 하나 + EscapeStack 이 처음 넣을 때 거는 둘(REFACTOR3_FE_ESC_SRS FR-FEE-2)
  assert.equal(e.keys.length, 3);
  assert.equal(e.keys[0].cap, true, '기본은 캡처다');
  const ov = d.ov;
  d._close(false);
  d._close(true);
  assert.equal(await p, false);
  assert.equal(e.log.filter((x) => x === 'release').length, 1);
  assert.equal(e.keys.length, 2, '키 수신기가 남았다');
  assert.equal(ctx.EscapeStack._items.length, 0, 'Esc 항목이 남았다');
  assert.equal(ov.parentNode, null, '오버레이가 남았다');
  assert.equal(d.ov, null);
});

test('TC-FED-3 키는 스택 맨 위(또는 빈 스택)일 때만 받는다 — Esc 는 EscapeStack 을 지나 _escape → _dismiss', () => {
  const e = env();
  const ctx = loadDialog(e);
  const d = new (probeClass(ctx, e))();
  let dismissed = 0;
  const got = [];
  d._dismiss = () => { dismissed++ };
  d._onKey = (k) => got.push(k.key);
  d._show();
  e.stack.push({ box: el('div') });
  e.keys[0].fn(key('Enter'));
  assert.deepEqual(got, [], '위에 다른 대화상자가 있는데 받았다');
  e.stack.pop();
  e.keys[0].fn(key('Enter'));
  assert.deepEqual(got, ['Enter']);
  const k2 = key('Escape');
  assert.equal(ctx.EscapeStack.handle(k2, 'capture'), true);
  assert.equal(dismissed, 1);
  assert.ok(k2.prevented && k2.stopped);
  assert.equal(d.isTop(), true);
  e.stack.length = 0;
  assert.equal(d.isTop(), true, '빈 스택이면 맨 위로 본다');
});

test('TC-FED-4 Git 모달은 Dialog 계층 위에 서고, 골격을 따로 갖지 않는다', () => {
  const e = env();
  const ctx = loadDialog(e, GIT, ['GitModalBase', 'GitConfirm', 'GitDialog', 'View', 'Component']);
  for (const C of [ctx.GitConfirm, ctx.GitDialog]) {
    for (const P of [ctx.GitModalBase, ctx.Dialog, ctx.View, ctx.Component]) {
      assert.ok(C.prototype instanceof P, C.name + ' 가 ' + P.name + ' 의 하위가 아니다');
    }
  }
  for (const m of ['_show', '_close', '_exec', '_front', '_copy', '_listenKeys']) {
    assert.ok(!Object.hasOwn(ctx.GitModalBase.prototype, m), 'GitModalBase 가 ' + m + ' 를 갖는다');
  }
});

test('TC-FED-5 UIKit.modal 은 KitModal 에 맡긴다 — 닫는 길이 여럿이어도 onClose 는 한 번', () => {
  const src = read('ui/ui-kit.js');
  const i = src.indexOf('  modal(spec) {');
  assert.ok(i >= 0);
  assert.match(src.slice(i, src.indexOf('\n  },', i)), /new KitModal\(/);

  const e = env();
  const ctx = load([...BASE, 'ui/ui-kit.js', ...DIALOG], {
    expose: ['UIKit', 'KitModal', 'Dialog', 'EscapeStack'],
    globals: { document: e.document, TIMERS: e.TIMERS },
  });
  assert.ok(ctx.KitModal.prototype instanceof ctx.Dialog);
  ctx.UIKit.dialogOpen = e.UIKit.dialogOpen;
  e.keys.length = 0;
  let closed = 0;
  const m = ctx.UIKit.modal({ head: false, body: el('p'), actions: [{ label: 'ok', value: 7 }], onClose: () => { closed++ } });
  for (const k of ['el', 'box', 'body', 'foot', 'close', 'defBtn']) assert.ok(m[k], k + ' 가 없다');
  assert.equal(e.keys.length, 3, '자기 키 수신기 하나 + EscapeStack 의 둘');
  m.el.listeners.mousedown({ target: m.el });
  m.close(3);
  e.keys.forEach((k) => k.fn(key('Escape')));
  assert.equal(closed, 1);
  assert.equal(e.keys.length, 2, '남는 것은 EscapeStack 의 둘뿐이다');
});

function settingsDom() {
  const ids = {};
  const overlay = el('div'); ids['modal-overlay'] = overlay;
  const modal = el('div'); ids.modal = modal; overlay.appendChild(modal);
  const tabs = modal.appendChild(el('div', 'modal-tabs'));
  const tA = tabs.appendChild(el('button', 'mtab active')); tA.dataset.tab = 'a';
  const tB = tabs.appendChild(el('button', 'mtab')); tB.dataset.tab = 'b';
  const body = modal.appendChild(el('div', 'modal-body'));
  const pA = body.appendChild(el('div', 'mpanel')); pA.id = 'panel-a'; ids['panel-a'] = pA;
  const pB = body.appendChild(el('div', 'mpanel')); pB.id = 'panel-b'; ids['panel-b'] = pB; pB.hidden = true;
  ids['settings-btn'] = el('button');
  ids['modal-close'] = el('button');
  return { ids, overlay, modal, tabs, tA, tB, pA, pB };
}

function settingsSetup() {
  const d = settingsDom();
  const e = env(d.ids);
  const ctx = loadDialog(e, ['core/settings-modal.js'], ['SettingsModal']);
  const calls = { open: 0, tab: [] };
  const sm = new ctx.SettingsModal({ onOpen: () => { calls.open++ }, onTab: (n) => calls.tab.push(n) }).init();
  return { d, e, ctx, sm, calls };
}

test('TC-FED-6 SettingsModal — 탭 줄 속성, 열기·닫기 길 셋, 두 번 닫기', () => {
  const { d, e, ctx, sm, calls } = settingsSetup();
  assert.ok(sm instanceof ctx.Dialog);
  assert.equal(d.tabs.attrs.role, 'tablist');
  assert.equal(d.tA.attrs.role, 'tab');
  assert.equal(d.tA.attrs['aria-controls'], 'panel-a');
  assert.equal(d.tA.attrs['aria-selected'], 'true');
  assert.equal(d.tB.attrs['aria-selected'], 'false');
  assert.equal(d.pB.attrs.role, 'tabpanel');
  assert.equal(d.pB.attrs['aria-labelledby'], d.tB.id);

  d.ids['settings-btn'].listeners.click();
  assert.ok(d.overlay.classList.contains('open'));
  assert.equal(sm.isOpen(), true);
  assert.equal(e.stack[0].spec.labelledBy, '.modal-title');
  assert.equal(e.stack[0].spec.returnTo, d.ids['settings-btn']);
  assert.equal(calls.open, 1);
  assert.deepEqual(e.log, ['dialogOpen', 'fade']);

  d.ids['modal-close'].listeners.click();
  assert.ok(!d.overlay.classList.contains('open'));
  assert.deepEqual(e.log.slice(2).sort(), ['release', 'unfade'], '닫을 때 풀 것 둘');
  sm.close();
  assert.equal(e.log.length, 4, '닫힌 뒤의 close 가 무언가를 했다');

  d.ids['settings-btn'].listeners.click();
  d.overlay.listeners.click({ target: d.modal });
  assert.ok(sm.isOpen(), '상자 안 클릭으로 닫혔다');
  d.overlay.listeners.click({ target: d.overlay });
  assert.ok(!sm.isOpen(), '바깥 클릭으로 닫히지 않았다');

  d.ids['settings-btn'].listeners.click();
  const S = ctx.EscapeStack;
  assert.equal(S._items.length, 1);
  assert.equal(S._items[0].phase, 'bubble', 'Esc 는 버블 층이다');
  const k = key('Escape');
  assert.equal(S.handle(k, 'capture'), false);
  assert.equal(S.handle(k, 'bubble'), true);
  assert.ok(!sm.isOpen());
  assert.ok(k.prevented);
  assert.ok(!k.stopped, '전파를 끊었다');
  assert.equal(S._items.length, 0, '닫힌 뒤에도 Esc 항목이 남았다');
  assert.equal(calls.open, 3);
});

test('TC-FED-6 SettingsModal.select 는 탭·aria·패널을 함께 고치고 onTab 을 부른다', () => {
  const { d, calls } = settingsSetup();
  d.tB.listeners.click();
  assert.ok(!d.tA.classList.contains('active'));
  assert.ok(d.tB.classList.contains('active'));
  assert.equal(d.tA.attrs['aria-selected'], 'false');
  assert.equal(d.tB.attrs['aria-selected'], 'true');
  assert.equal(d.pA.hidden, true);
  assert.equal(d.pB.hidden, false);
  assert.deepEqual(calls.tab, ['b']);
});

test('TC-FED-7 옮긴 골격이 옛 자리에 남지 않았다', () => {
  const s = read('core/settings-controller.js');   // `_openSettings` 의 자리 (REFACTOR3_FE_APPCTL_SRS 9a)
  assert.doesNotMatch(s, /UIKit\.dialogOpen\(/);
  assert.doesNotMatch(s, /classList\.remove\('open'\)/);
  assert.doesNotMatch(read('git/git-modal-base.js'), /removeEventListener\('keydown'/);
});
