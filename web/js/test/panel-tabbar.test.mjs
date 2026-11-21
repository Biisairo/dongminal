import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, MOBILE, PANELS, controllers, load } from './harness.mjs';

/**
 * REFACTOR3_FE_BASE_SRS 단계 2 — 패널과 탭 줄.
 *   TC-FEB-20 TabBar · TC-FEB-21 두 탭 줄의 라벨 판정 경로(FR-FEB-26) · TC-FEB-22 DrawerSheet · FR-FEB-23 Panel
 */
const json = (v) => JSON.stringify(v);

// ── 최소 DOM ─────────────────────────────────────────────────────────────
// 이 시험이 쓰는 선택자는 `.cls`·`[data-x="v"]`·둘을 이은 꼴뿐이다.

function descendants(root) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { out.push(c); walk(c) } };
  walk(root);
  return out;
}

function matches(x, sel) {
  const m = sel.match(/^(?:\.([\w-]+))?(?:\[data-(\w+)="([^"]*)"\])?$/);
  if (!m) throw new Error('선택자를 모른다: ' + sel);
  if (m[1] && !x.classList.contains(m[1])) return false;
  if (m[2] && x.dataset[m[2]] !== m[3]) return false;
  return true;
}

function el(tag, cls) {
  const classes = new Set();
  const e = {
    tagName: tag, children: [], parentNode: null, hidden: false, dataset: {}, attrs: {}, title: '', textContent: '', scrollTop: 0,
    listeners: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on },
    },
    get className() { return [...classes].join(' ') },
    set className(v) { classes.clear(); for (const c of String(v).split(' ').filter(Boolean)) classes.add(c) },
    get childElementCount() { return this.children.length },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c },
    remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null } },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; return on },
    hasAttribute(k) { return k in this.attrs },
    addEventListener(t, fn) { this.listeners[t] = fn },
    querySelector(sel) { return descendants(this).find((x) => matches(x, sel)) || null },
    querySelectorAll(sel) { return descendants(this).filter((x) => matches(x, sel)) },
  };
  e.className = cls || '';
  return e;
}

const observers = [];
class FakeRO {
  constructor(fn) { this.fn = fn; this.targets = []; observers.push(this) }
  observe(t) { this.targets.push(t) }
  disconnect() { this.off = true }
}
/** 이 요소를 보는 관측자의 콜백을 부른다 — 폭이 바뀐 것과 같다. */
const resize = (target) => { for (const o of observers) if (!o.off && o.targets.includes(target)) o.fn() };

function memStore() {
  const m = new Map();
  return {
    m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)) },
    remove: (k) => { m.delete(k) },
    setBool: (k, on) => { m.set(k, on ? '1' : '0') },
  };
}

function setup() {
  const ids = {
    'sb-tabs': el('div', 'ui-panel-tabs'),
    sidebar: el('div', 'ui-panel'),
    'agents-panel': el('div', 'ui-panel'),
    'agents-handle': el('div'),
    'agents-body': el('div'),
    'sb-panel-a': el('div'),
    'sb-panel-b': el('div'),
    'sb-panel-c': el('div'),
  };
  const fits = [];
  let built = 0;
  const document = {
    getElementById: (id) => ids[id] || null,
    documentElement: el('html'),
    body: el('body'),
    createElement: (t) => el(t),
    addEventListener() {},
  };
  const UIKit = {
    tab(s) {
      built++;
      const b = el('button', ['ui-tab', s.cls || ''].join(' '));
      if (s.id) b.dataset.panel = s.id;
      if (s.title) b.title = s.title;
      if (s.label) { const l = el('span', 'ui-tab-label ' + (s.labelCls || '')); l.textContent = s.label; b.appendChild(l) }
      const g = el('span', 'ui-tab-badge ' + (s.badgeCls || ''));
      g.hidden = true;
      b.appendChild(g);
      if (s.onClick) b.addEventListener('click', s.onClick);
      return b;
    },
    tabsFit: (bar) => { fits.push(bar) },
    scrollSave: () => {},
    scrollRestore: () => {},
  };
  const local = memStore(), session = memStore();
  const sbDefs = [
    { id: 'a', label: 'A', panelId: 'sb-panel-a', badge: (app) => app.nA || 0 },
    { id: 'b', label: 'B', panelId: 'sb-panel-b' },
    { id: 'c', label: 'C', panelId: 'sb-panel-c', visible: (app) => !!app.cOn },
  ];
  const sections = [
    { key: 'agents', icon: 'bot', title: () => 'Agents', tip: () => 'agents tip' },
    { key: 'bg', icon: 'terminal-bg', title: () => 'Background', tip: () => 'bg tip' },
    { key: 'runs', icon: 'workflow', title: () => 'Runs', tip: () => 'runs tip' },
  ];
  const ctx = load([...BASE, ...PANELS, ...MOBILE], {
    expose: ['Panel', 'TabBar', 'SidebarTabBar', 'SidebarPanel', 'DrawerSheet', 'ActivityTabBar', 'ActivityPanel', 'EscapeStack'],
    globals: {
      document, UIKit, ResizeObserver: FakeRO, App: class {},
      PrefStore: { local, session },
      STORE_KEYS: { activityTab: 'activityTab', agentsPanelOpen: 'agentsPanelOpen' },
      SB_TAB_KEY: 'sidebarTab', SB_TAB_DEFS: sbDefs, ACTIVITY_SECTIONS: sections,
      SIDEBAR_COLLAPSED_CLASS: 'sb-collapsed', SIDEBAR_COLLAPSED_KEY: 'sidebarCollapsed',
      REPO_TAB_ID: 'repo', CHAT_TAB_ID: 'chat',
      domEl: (t, c) => el(t, c),
    },
  });
  /** 사이드바와 작업 패널 쪽을 함께 든 App 대역. */
  const app = controllers(ctx, new ctx.App());
  Object.assign(app, {
    sbTab: 'a', sbBusy: false, isMobile: false, tools: new Map(), refreshes: 0, renders: 0,
    mobileChromeSync() {}, _actRefresh() { app.refreshes++ },
    sbPanel() { return this._sb || (this._sb = new ctx.SidebarPanel(this)) },
    actPanel() { return this._act || (this._act = new ctx.ActivityPanel(this)) },
    sidebarCollapsed() { return !this.sbPanel().isOpen() },
    setSidebarCollapsed(on) { this.sbPanel().setOpen(!on) },
    agentsPanelOpen() { return this.actPanel().isOpen() },
    setAgentsPanelOpen(v) { this.actPanel().setOpen(v) },
    /** `agentsRender` 의 탭 줄 부분 — 줄을 두고 센 값으로 그린다. */
    agentsRender() {
      app.renders++;
      const tb = this.actPanel().tabs;
      tb.ensure();
      tb.paintWith(sections.map((s) => ({ key: s.key, tip: s.tip(), n: app.counts[s.key] || 0, dot: !!app.dots[s.key] })));
    },
    counts: {}, dots: {},
  });
  return { ctx, ids, app, fits, local, session, document, built: () => built };
}

// ── TC-FEB-20 TabBar ──────────────────────────────────────────────────────

test('TC-FEB-20: 단추는 줄이 비었을 때만 만든다 — 두 번 그려도 한 벌이다', () => {
  const { app, ids, built } = setup();
  const sb = app.sbPanel().tabs;
  sb.paint();
  sb.paint();
  assert.equal(built(), 3);
  assert.equal(ids['sb-tabs'].children.length, 3);
  assert.equal(ids['sb-tabs'].attrs.role, 'tablist');
  // 줄이 비면(e2e 가 서술자를 더한 뒤처럼) 다시 만든다.
  ids['sb-tabs'].children.length = 0;
  sb.paint();
  assert.equal(built(), 6);
});

test('TC-FEB-20: select 는 자리 적기 → 고르기 → 그리기 → 되돌리기 → onLeave·onEnter·onSelect 순서다', () => {
  const { ctx, local } = setup();
  const log = [];
  class T extends ctx.TabBar {
    defs() { return [{ id: 'x' }, { id: 'y' }] }
    render() { log.push('render:' + this.current) }
    saveScroll(id) { log.push('save:' + id) }
    restoreScroll(id) { log.push('restore:' + id) }
    onLeave(p) { log.push('leave:' + p.id) }
    onEnter(n) { log.push('enter:' + n.id) }
    onSelect(n, o) { log.push('select:' + n.id + ':' + json(o || null)) }
  }
  const t = new T({ persistKey: 'k' });
  t.current = 'x';
  assert.equal(t.select('y', { silent: true }), true);
  assert.equal(json(log), json(['save:x', 'render:y', 'restore:y', 'leave:x', 'enter:y', 'select:y:{"silent":true}']));
  assert.equal(local.get('k'), 'y');
  log.length = 0;
  assert.equal(t.select('y'), false, '같은 탭');
  assert.equal(t.select('nope'), false, '모르는 탭');
  assert.equal(json(log), '[]');
});

test('TC-FEB-20: jump 의 세 갈래 — 펼친 채 같은 탭 → 접기 / 다른 탭 → 고르기 / 접힘 → 고르고 펼치기', () => {
  const { ctx } = setup();
  const log = [];
  class T extends ctx.TabBar {
    constructor() { super(); this.folded = false; this.foldable = true }
    defs() { return [{ id: 'x' }, { id: 'y' }] }
    render() {}
    canFold() { return this.foldable }
    isFolded() { return this.folded }
    setFolded(v) { log.push('fold:' + v); this.folded = v }
  }
  const t = new T();
  t.current = 'x';
  t.jump(1);
  assert.equal(json([log, t.current, t.folded]), json([['fold:true'], 'x', true]), '펼친 채 같은 탭');
  log.length = 0;
  t.jump(2);
  assert.equal(json([log, t.current, t.folded]), json([['fold:false'], 'y', false]), '접힘 → 고르고 펼치기');
  log.length = 0;
  t.jump(1);
  assert.equal(json([log, t.current, t.folded]), json([[], 'x', false]), '다른 탭 → 고르기만');
  t.foldable = false;
  t.jump(1);
  assert.equal(json([log, t.current]), json([[], 'x']), '접을 수 없으면 같은 탭은 아무 일도 없다');
  t.jump(9);
  assert.equal(t.current, 'x', '없는 번호');
});

test('SidebarTabBar: 숨은 탭·패널·배지, 보던 탭이 숨으면 첫 탭, 재진입 가드', () => {
  const { app, ids } = setup();
  const sb = app.sbPanel().tabs;
  app.nA = 3;
  sb.paint();
  const tab = (id) => ids['sb-tabs'].querySelector('.sb-tab[data-panel="' + id + '"]');
  assert.equal(json([tab('a').hidden, tab('c').hidden, ids['sb-panel-a'].hidden, ids['sb-panel-b'].hidden]), json([false, true, false, true]));
  assert.equal(json([tab('a').classList.contains('active'), tab('a').attrs['aria-selected']]), json([true, 'true']));
  const g = tab('a').querySelector('.ui-tab-badge');
  assert.equal(json([g.hidden, g.textContent]), json([false, '3']));
  app.sbTab = 'c';   // 보이지 않는 탭
  sb.paint();
  assert.equal(app.sbTab, 'a');
  app.sbBusy = true;
  assert.equal(sb.select('b'), false);
  app.sbBusy = false;
  assert.equal(sb.select('b'), true);
  assert.equal(app.sbTab, 'b');
});

test('ActivityTabBar: 수 배지·알람 점·툴팁, 탭마다 몸통 스크롤 자리, 모르는 저장 값은 첫 탭', () => {
  const { app, ids, local } = setup();
  local.set('activityTab', 'chats');
  const tb = app.actPanel().tabs;
  assert.equal(tb.current, 'agents');
  app.counts = { bg: 2 };
  app.dots = { agents: true };
  app.agentsRender();
  const tab = (id) => tb.el.querySelector('.ag-tab[data-sec="' + id + '"]');
  assert.equal(json([tb.el.className, tb.el.attrs.role]), json(['ag-tabs ui-panel-tabs', 'tablist']));
  assert.equal(json([tab('bg').querySelector('.ag-tab-n').hidden, tab('bg').querySelector('.ag-tab-n').textContent]), json([false, '2']));
  assert.ok(tab('agents').querySelector('.ag-tab-dot'), '알람 점');
  assert.equal(tab('runs').title, 'runs tip');
  app.dots = {};
  app.agentsRender();
  assert.equal(tab('agents').querySelector('.ag-tab-dot'), null);
  ids['agents-body'].scrollTop = 120;
  tb.select('bg');
  assert.equal(json([tb.current, local.get('activityTab'), ids['agents-body'].scrollTop]), json(['bg', 'bg', 0]));
  ids['agents-body'].scrollTop = 40;
  tb.select('agents');
  assert.equal(ids['agents-body'].scrollTop, 120);
  tab('runs').listeners.click({ stopPropagation() {} });
  assert.equal(tb.current, 'runs');
});

// ── TC-FEB-21 두 탭 줄의 라벨 판정 경로 (FR-FEB-26) ─────────────────────────

/**
 * 같은 사건에서 두 줄이 같은 길(`TabBar.fit` → `UIKit.tabsFit(자기 줄)`)을 지나는가.
 * `fit` 을 감싸 어느 줄이 몇 번 재었는지 센다.
 */
function fitSpy(ctx, fits, sb, act) {
  const orig = ctx.TabBar.prototype.fit;
  const n = { sb: 0, act: 0 };
  ctx.TabBar.prototype.fit = function () { if (this === sb) n.sb++; if (this === act) n.act++; return orig.call(this) };
  return {
    take() {
      const r = { sb: n.sb, act: n.act, sbOwn: fits.filter((b) => b === sb.el).length, actOwn: fits.filter((b) => b === act.el).length };
      n.sb = 0; n.act = 0; fits.length = 0;
      return r;
    },
  };
}

test('TC-FEB-21: 배지·폭·탭 전환·다시 그리기·펼치기·모바일 진입에서 두 줄이 같은 판정 길을 지난다', () => {
  const { ctx, app, fits, document } = setup();
  const sb = app.sbPanel().tabs, act = app.actPanel().tabs;
  sb.paint();
  app.agentsRender();
  const spy = fitSpy(ctx, fits, sb, act);
  spy.take();
  const both = (what, r) => {
    assert.ok(r.sb >= 1 && r.act >= 1, what + ': 두 줄 모두 재야 한다 ' + json(r));
    assert.ok(r.sbOwn >= 1 && r.actOwn >= 1, what + ': 자기 줄을 재야 한다 ' + json(r));
  };

  // 배지 변화 — 사이드바는 `_sbUpdateBadges`(→ paintBadges), 작업 패널은 다시 그리기의 센 값.
  app.nA = 5; sb.paintBadges();
  app.counts = { bg: 7 }; app.agentsRender();
  both('배지', spy.take());

  // 폭 변화 — 관측은 두 패널 모두 자기 탭 줄에 걸린다.
  resize(sb.el); resize(act.el);
  both('폭', spy.take());

  // 탭 전환.
  sb.select('b'); act.select('bg');
  both('탭 전환', spy.take());

  // 다시 그리기.
  sb.paint(); app.agentsRender();
  both('다시 그리기', spy.take());

  // 레일에서 펼치기 — 이전: 사이드바는 관측만 기다렸고 작업 패널은 다시 그리며 쟀다.
  app.setAgentsPanelOpen(true); spy.take();
  app.setSidebarCollapsed(true); app.setAgentsPanelOpen(false);
  both('접기', spy.take());
  app.setSidebarCollapsed(false); app.setAgentsPanelOpen(true);
  both('펼치기', spy.take());

  // 모바일 진입 — 이전: 작업 패널이 닫혀 있으면 다시 그리기가 일찍 돌아가 재지 않았다.
  app.isMobile = true;
  app.applyMobileMode();
  assert.ok(document.body.classList.contains('mobile'));
  both('모바일 진입', spy.take());
});

// ── FR-FEB-23 Panel ───────────────────────────────────────────────────────

test('FR-FEB-23: Panel — 열림은 루트의 클래스 하나, 바뀔 때만 훅과 영속, 등록은 escapable 일 때만', () => {
  const { ctx, ids, session } = setup();
  const log = [];
  class P extends ctx.Panel {
    onOpen() { log.push('open') }
    onClose() { log.push('close') }
  }
  const p = new P({ rootId: 'sidebar', persistKey: 'pk', escapable: true });
  assert.equal(p.open(), true);
  assert.equal(json([ids.sidebar.classList.contains('open'), session.get('pk'), log]), json([true, '1', ['open']]));
  assert.equal(p.open(), false, '같은 값');
  assert.equal(ctx.EscapeStack._items.includes(p), true);
  ctx.EscapeStack.handle({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(json([p.isOpen(), session.get('pk'), log]), json([false, '0', ['open', 'close']]));
  assert.equal(ctx.EscapeStack._items.includes(p), false);
  const q = new P({ rootId: 'agents-panel' });
  q.toggle();
  assert.equal(json([q.isOpen(), ctx.EscapeStack._items.includes(q)]), json([true, false]));
});

test('FR-FEE-5: 서랍과 작업 패널은 EscapeStack 버블 층이고 모바일에서만 살아 있다 — 사이드바는 등록하지 않는다', () => {
  const { ctx, app } = setup();
  const d = new ctx.DrawerSheet(app);
  const a = app.actPanel();
  assert.equal(json([app.sbPanel().escapable, a.escapable, d.escapable]), json([false, true, true]));
  assert.equal(json([a.phase, d.phase]), json(['bubble', 'bubble']));
  app.isMobile = false;
  assert.equal(json([a.active(), d.active()]), json([false, false]));
  app.isMobile = true;
  assert.equal(json([a.active(), d.active()]), json([true, true]));
});

test('FR-FEB-24: SidebarPanel — 접힘 표식은 documentElement 하나, 저장은 접힘일 때만 "1"', () => {
  const { app, document, session } = setup();
  let painted = 0;
  app.sbCollapsePaint = () => { painted++ };
  app.setSidebarCollapsed(true);
  assert.equal(json([document.documentElement.classList.contains('sb-collapsed'), session.get('sidebarCollapsed'), app.sidebarCollapsed(), painted]),
    json([true, '1', true, 1]));
  app.setSidebarCollapsed(true);
  assert.equal(painted, 1, '같은 값이면 아무것도 하지 않는다');
  app.setSidebarCollapsed(false);
  assert.equal(json([document.documentElement.classList.contains('sb-collapsed'), session.get('sidebarCollapsed'), painted]), json([false, null, 2]));
});

test('FR-FEB-24: ActivityPanel — 손잡이·영속·재조회·다시 그리기, show(key) 는 직행 키 토글', () => {
  const { app, ids, session } = setup();
  const p = app.actPanel();
  p.show('runs');
  assert.equal(json([p.isOpen(), ids['agents-handle'].classList.contains('open'), session.get('agentsPanelOpen'), p.tabs.current, app.refreshes]),
    json([true, true, '1', 'runs', 1]));
  p.show('bg');
  assert.equal(json([p.isOpen(), p.tabs.current, app.refreshes]), json([true, 'bg', 2]), '열린 패널에서 다른 구역 → 다시 받는다');
  p.show('bg');
  assert.equal(json([p.isOpen(), ids['agents-handle'].classList.contains('open'), session.get('agentsPanelOpen')]), json([false, false, '0']), '보던 구역 → 닫는다');
  p.show();
  assert.equal(p.isOpen(), true, '구역 없이 → 토글');
});

// ── REFACTOR3_FE_REST4_SRS TC-FR4-3 레일 표식 ──────────────────────────────

test('TC-FR4-3: 레일 표식은 레일을 갖는 패널이 닫혀 있고 데스크톱일 때만 선다 — 열림이 바뀔 때 다시 선다', () => {
  const { app, ids } = setup();
  const rail = () => ['data-rail' in ids.sidebar.attrs, 'data-rail' in ids['agents-panel'].attrs];
  assert.equal(json([app.sbPanel().rail, app.actPanel().rail]), json([true, true]));
  app.setSidebarCollapsed(true);
  assert.equal(json(rail()), json([true, false]), '사이드바 접힘 → 레일');
  app.setAgentsPanelOpen(true);
  assert.equal(json(rail()), json([true, false]), '작업 패널 펼침 → 레일 아님');
  app.setAgentsPanelOpen(false);
  assert.equal(json(rail()), json([true, true]), '작업 패널 닫힘 → 레일');
  app.setSidebarCollapsed(false);
  assert.equal(json(rail()), json([false, true]), '사이드바 펼침 → 레일 아님');
});

test('TC-FR4-3: 모바일 진입·이탈에 두 패널의 표식이 함께 다시 선다 — 모바일에서는 닫혀 있어도 레일이 아니다', () => {
  const { app, ids, document } = setup();
  const rail = () => ['data-rail' in ids.sidebar.attrs, 'data-rail' in ids['agents-panel'].attrs];
  app.setSidebarCollapsed(true);
  app.setAgentsPanelOpen(true);
  app.setAgentsPanelOpen(false);
  assert.equal(json(rail()), json([true, true]));
  app.isMobile = true;
  app.applyMobileMode();
  assert.ok(document.body.classList.contains('mobile'));
  assert.equal(json(rail()), json([false, false]), '모바일 진입 → 둘 다 레일 아님');
  app.setAgentsPanelOpen(true);
  app.setAgentsPanelOpen(false);
  assert.equal(json(rail()), json([false, false]), '모바일에서 닫아도 레일 아님');
  app.isMobile = false;
  app.applyMobileMode();
  assert.equal(json(rail()), json([true, true]), '모바일 이탈 → 다시 레일');
});

test('TC-FR4-3: 서랍(DrawerSheet)은 레일을 갖지 않는다 — #sidebar 를 열고 닫아도 표식을 건드리지 않는다', () => {
  const { ctx, app, ids } = setup();
  app.setSidebarCollapsed(true);
  assert.equal('data-rail' in ids.sidebar.attrs, true);
  const d = new ctx.DrawerSheet(app);
  assert.equal(d.rail, false);
  d.open();
  assert.equal(json([ids.sidebar.classList.contains('open'), 'data-rail' in ids.sidebar.attrs]), json([true, true]));
  d.close();
  app.setSidebarCollapsed(false);
  d.open();
  d.close();
  assert.equal('data-rail' in ids.sidebar.attrs, false);
});

// ── TC-FEB-22 DrawerSheet ─────────────────────────────────────────────────

test('TC-FEB-22: DrawerSheet — 필드·body.drawer-open·#sidebar.open 이 함께 바뀌고 상단바를 다시 그린다', () => {
  const { ctx, ids, document } = setup();
  let top = 0, chrome = 0;
  const app = { drawerOpen: false, mobileChromeSync() { chrome++ } };
  const d = new ctx.DrawerSheet(app, { onChange: () => { top++ } });
  const state = () => [app.drawerOpen, document.body.classList.contains('drawer-open'), ids.sidebar.classList.contains('open'), top, chrome];
  d.open();
  assert.equal(json(state()), json([true, true, true, 1, 1]));
  d.open();
  assert.equal(json(state()), json([true, true, true, 1, 1]), '같은 값이면 다시 그리지 않는다');
  d.close();
  assert.equal(json(state()), json([false, false, false, 2, 2]));
});

test('TC-FEB-22: _toggleDrawer — 모바일은 토글, 데스크톱은 닫힌 채 하단 크롬만 맞춘다', () => {
  const { app, ids, document } = setup();
  let top = 0, chrome = 0;
  app.renderer = { _rTopbar: () => { top++ } };
  app.mobileChromeSync = () => { chrome++ };
  app.isMobile = true;
  app._toggleDrawer();
  assert.equal(json([app.drawerOpen, ids.sidebar.classList.contains('open'), document.body.classList.contains('drawer-open'), top]), json([true, true, true, 1]));
  app._toggleDrawer(false);
  assert.equal(json([app.drawerOpen, ids.sidebar.classList.contains('open'), top]), json([false, false, 2]));
  app.isMobile = false;
  chrome = 0;
  app._toggleDrawer(true);
  assert.equal(json([app.drawerOpen, ids.sidebar.classList.contains('open'), top, chrome]), json([false, false, 2, 1]));
});
