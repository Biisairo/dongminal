/**
 * Dongminal — 패널 레이아웃: 탭별 상태와 저장 레이아웃 (PANEL_LAYOUT_SRS).
 *
 * 패널 배치는 탭마다 따로다(`sessionStorage`). 사용자가 저장한 레이아웃(`localStorage`)은
 * 새 탭이 처음 열릴 때 한 번 탭 상태로 옮긴다(씨앗 넣기, FR-PLY-20). 폭은 비율로 저장한다.
 *
 * **이 파일은 첫 페인트 전에 돈다** (FR-PLY-22). 그래서 `constants.js`·`PrefStore` 를 쓸 수
 * 없고, 키 이름과 폭 범위를 여기 적는다. 키 이름은 `STORE_KEYS` 와 같은지 단위 시험이 본다.
 * 폭 범위는 `SIDEBAR_W_*`·`AGENTS_W_*`(constants.js)·`REPO_SIDE_W_*`(constants-editor.js)와 같다.
 */
const PLY_KEYS = Object.freeze({
  seeded: 'layoutSeeded',
  saved: 'panelLayout',
  panelDock: 'panelDock',
  repoSideDock: 'repoSideDock',
  sidebarWidth: 'sidebarWidth',
  sidebarCollapsed: 'sidebarCollapsed',
  repoSideWidth: 'repoSideWidth',
  agentsWidth: 'agentsWidth',
  agentsPanelOpen: 'agentsPanelOpen',
});

const PLY_RANGE = Object.freeze({
  sidebar: [100, 400],
  activity: [160, 480],
  repoSideW: [100, 520],
});

// FR-PLY-30: 업데이트 전에 localStorage 에 살던 키. 옮긴 뒤 지운다.
const PLY_LEGACY_KEYS = ['panelDock', 'repoSideDock', 'sidebarCollapsed', 'agentsPanelOpen', 'agentsWidth'];

function plyRatio(px, innerWidth) {
  if (!(px > 0) || !(innerWidth > 0)) return undefined;
  const r = Math.round((px / innerWidth) * 10000) / 10000;
  return r > 0 && r < 1 ? r : undefined;
}

function plyRatioOk(r) { return typeof r === 'number' && r > 0 && r < 1 }

function plyDockOk(d) {
  return !!d && Array.isArray(d.left) && Array.isArray(d.right)
    && d.left.concat(d.right).every(x => typeof x === 'string');
}

/** FR-PLY-10: 저장 레이아웃을 읽는다. 읽을 수 없으면 null, 잘못된 필드는 뺀다. */
function layoutParse(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw) } catch (e) { return null }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return null;
  const out = { v: 1 };
  if (plyDockOk(o.dock)) out.dock = { left: o.dock.left.slice(), right: o.dock.right.slice() };
  if (o.repoSide === 'left' || o.repoSide === 'right') out.repoSide = o.repoSide;
  const part = (name, flag) => {
    const p = o[name];
    if (!p || typeof p !== 'object') return;
    const q = {};
    if (plyRatioOk(p.ratio)) q.ratio = p.ratio;
    if (flag && typeof p[flag] === 'boolean') q[flag] = p[flag];
    out[name] = q;
  };
  part('sidebar', 'collapsed');
  part('repoSideW', '');
  part('activity', 'open');
  return out;
}

/** FR-PLY-11: 지금 탭의 배치를 저장 레이아웃으로 만든다. */
function layoutCapture(st, innerWidth) {
  const out = { v: 1 };
  if (plyDockOk(st.dock)) out.dock = { left: st.dock.left.slice(), right: st.dock.right.slice() };
  if (st.repoSide === 'left' || st.repoSide === 'right') out.repoSide = st.repoSide;
  const part = (name, px, flag, val) => {
    const q = {};
    const r = plyRatio(px, innerWidth);
    if (r !== undefined) q.ratio = r;
    if (flag) q[flag] = !!val;
    if (Object.keys(q).length) out[name] = q;
  };
  part('sidebar', st.sidebarPx, 'collapsed', st.sidebarCollapsed);
  part('repoSideW', st.repoSidePx, '', false);
  part('activity', st.activityPx, 'open', st.activityOpen);
  return out;
}

/** FR-PLY-21·23: 저장 레이아웃 → 탭 상태 키·값. 비율은 이 화면의 px 로 바꾸고 범위로 접는다. */
function layoutSeedEntries(lay, innerWidth) {
  const out = [];
  const px = (name, ratio) => {
    const [lo, hi] = PLY_RANGE[name];
    return String(Math.max(lo, Math.min(hi, Math.round(ratio * innerWidth))));
  };
  if (lay.dock) out.push([PLY_KEYS.panelDock, JSON.stringify(lay.dock)]);
  if (lay.repoSide) out.push([PLY_KEYS.repoSideDock, lay.repoSide]);
  const sb = lay.sidebar || {};
  if (sb.ratio !== undefined) out.push([PLY_KEYS.sidebarWidth, px('sidebar', sb.ratio)]);
  if (sb.collapsed) out.push([PLY_KEYS.sidebarCollapsed, '1']);
  const rs = lay.repoSideW || {};
  if (rs.ratio !== undefined) out.push([PLY_KEYS.repoSideWidth, px('repoSideW', rs.ratio)]);
  const ag = lay.activity || {};
  if (ag.ratio !== undefined) out.push([PLY_KEYS.agentsWidth, px('activity', ag.ratio)]);
  if (typeof ag.open === 'boolean') out.push([PLY_KEYS.agentsPanelOpen, ag.open ? '1' : '0']);
  return out;
}

/** FR-PLY-30: 옛 localStorage 값으로 저장 레이아웃을 만든다. 옛 값이 하나도 없으면 null. */
function layoutFromLegacy(get, innerWidth) {
  const v = {};
  for (const k of PLY_LEGACY_KEYS) v[k] = get(k);
  if (PLY_LEGACY_KEYS.every(k => v[k] === null)) return null;
  let dock = null;
  try { dock = JSON.parse(v.panelDock) } catch (e) { dock = null }
  const st = {
    dock,
    repoSide: v.repoSideDock,
    sidebarCollapsed: v.sidebarCollapsed === '1',
    activityPx: parseInt(v.agentsWidth, 10),
    activityOpen: v.agentsPanelOpen === '1',
  };
  const lay = layoutCapture(st, innerWidth);
  // 옛 값에 없던 것은 저장하지 않는다 — 기본값과 같은 표시만 남는다.
  if (v.sidebarCollapsed === null && lay.sidebar && lay.sidebar.ratio === undefined) delete lay.sidebar;
  if (v.agentsPanelOpen === null && lay.activity) {
    delete lay.activity.open;
    if (lay.activity.ratio === undefined) delete lay.activity;
  }
  return lay;
}

/** FR-PLY-20·30: 탭이 열릴 때 한 번. 새로고침이면 아무것도 하지 않는다. */
function layoutBoot(local, session, innerWidth) {
  const legacy = layoutFromLegacy(k => local.getItem(k), innerWidth);
  if (legacy) {
    if (local.getItem(PLY_KEYS.saved) === null) local.setItem(PLY_KEYS.saved, JSON.stringify(legacy));
    for (const k of PLY_LEGACY_KEYS) local.removeItem(k);
  }
  if (session.getItem(PLY_KEYS.seeded) !== null) return;
  session.setItem(PLY_KEYS.seeded, '1');
  const lay = layoutParse(local.getItem(PLY_KEYS.saved));
  if (!lay) return;
  for (const [k, v] of layoutSeedEntries(lay, innerWidth)) session.setItem(k, v);
}

// 저장소가 막힌 환경(사생활 모드)에서도 화면은 떠야 한다 — 기본값으로 시작한다.
try { layoutBoot(localStorage, sessionStorage, window.innerWidth) } catch (e) { console.warn('[layout] 저장소를 쓸 수 없어 기본 배치로 시작합니다', e) }
