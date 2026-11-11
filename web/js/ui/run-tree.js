/**
 * Run 대시보드의 「이슈 트리」 영역 (ISSUE_AGENT_TREE_SRS 묶음 D).
 * `run-dashboard.js` 의 증강 분할이다 — 그 파일이 500줄 경계를 넘지 않게 갈랐다(FR-STR-40).
 */
Object.assign(RunsPanel.prototype, {
  /**
   * ISSUE_AGENT_TREE_SRS FR-ITD-1~4: 이슈 트리. 노드 = 그 트리의 열린 Run 들의 멤버이고,
   * 부모·잎은 서버가 사슬 이름에서 정했다. 누르면 그 에이전트의 탭으로 간다.
   * ISSUE_TREE_OPS_SRS FR-ITC-6·10: 위에서 아래로 내려가는 도형 다이어그램(SVG)이다.
   */
  _runPaintTree(root, tree) {
    const el = root.querySelector('.run-tree');
    const nodes = (tree && tree.nodes) || [];
    el.classList.toggle('vis', !!tree);
    // ISSUE_TREE_OPS_SRS FR-ITC-6: 트리 Run 은 평평한 그래프 대신 트리가 중심이다.
    root.classList.toggle('tree-run', !!tree);
    const sig = tree ? JSON.stringify(nodes.map(n => [n.id, n.role, n.parent, n.state, n.leaf, n.contextRatio || 0, n.issue || '', n.title || ''])) : '';
    paintIfChanged(el, sig, () => {
      el.textContent = '';
      if (!tree) return;
      el.appendChild(runDiv('run-tree-h', t('runs.tree_title', {ref: tree.tree})));
      if (!nodes.length) { el.appendChild(runDiv('run-tree-empty', t('runs.tree_empty'))); return }
      const lay = runTreeLayout(nodes);
      const svg = runSvg('svg', { class: 'run-tree-svg', viewBox: `0 0 ${lay.w} ${lay.h}` });
      svg.dataset.w = lay.w;
      svg.dataset.h = lay.h;
      const edges = runSvg('g', { class: 'run-tree-edges' });
      for (const [p, c] of lay.edges) edges.appendChild(runSvg('path', { class: 'run-tree-edge', d: runTreeEdgePath(lay.pos[p], lay.pos[c]) }));
      svg.appendChild(edges);
      nodes.forEach((n, i) => svg.appendChild(this._runTreeNodeEl(n, lay.pos[i])));
      // FR-ITC-11: 높이가 고정된 보기 영역. 줌·패닝은 viewBox 만 바꾼다 (`_runTreeCam`).
      const wrap = runDiv('run-tree-wrap');
      wrap.appendChild(svg);
      wrap.appendChild(this._runTreeHud(nodes, lay));
      el.appendChild(wrap);
      this._runTreeWire(root, wrap, svg);
    });
    this._runTreeCam(root);
  },

  /**
   * FR-ITC-11·12·17: 영역 높이(Run 화면의 50%)와 보기를 정한다. 사용자가 움직이기 전이면
   * 맞춤이고, 움직인 뒤에는 그 보기를 지킨다 — 다시 그려도 viewBox 좌표는 같은 트리에서 같다.
   * 보기 상태는 Run 화면(root)에 둔다. 트리 영역은 데이터가 바뀌면 새로 만들어진다.
   */
  _runTreeCam(root) {
    const wrap = root.querySelector('.run-tree-wrap');
    const svg = wrap && wrap.querySelector('.run-tree-svg');
    if (!svg) return;
    wrap.style.height = Math.round(root.clientHeight * RUN_TREE_AREA_RATIO) + 'px';
    const tree = { w: Number(svg.dataset.w), h: Number(svg.dataset.h) };
    const area = { w: wrap.clientWidth, h: wrap.clientHeight };
    const fit = runCamFit(tree, area);
    if (!fit) return;
    const st = root._treeCam || (root._treeCam = { cam: null, user: false });
    Object.assign(st, { fit, tree, area, range: runCamRange(fit.s) });
    if (!st.user || !st.cam) st.cam = fit;
    else st.cam = runCamClamp(st.cam, tree, area);
    this._runTreeApply(root);
  },

  /** 보기를 viewBox · 게이지 · 미니맵에 옮긴다. */
  _runTreeApply(root) {
    const st = root._treeCam;
    const wrap = root.querySelector('.run-tree-wrap');
    if (!st || !st.cam || !wrap) return;
    const { s, x, y } = st.cam;
    wrap.querySelector('.run-tree-svg').setAttribute('viewBox', `${x} ${y} ${st.area.w / s} ${st.area.h / s}`);
    const zoom = wrap.querySelector('.run-tree-zoom');
    zoom.min = String(Math.round(st.range.min * 100));
    zoom.max = String(Math.round(st.range.max * 100));
    zoom.value = String(Math.round(s * 100));
    wrap.querySelector('.run-tree-pct').textContent = Math.round(s * 100) + '%';
    const v = wrap.querySelector('.run-tree-mini-view');
    v.setAttribute('x', x); v.setAttribute('y', y);
    v.setAttribute('width', st.area.w / s); v.setAttribute('height', st.area.h / s);
  },

  /** 사용자가 보기를 바꿨다 — 경계 안으로 당기고 그린다. 이후로는 맞춤으로 돌아가지 않는다(FR-ITC-17). */
  _runTreeMove(root, cam) {
    const st = root._treeCam;
    if (!st) return;
    st.cam = runCamClamp(cam, st.tree, st.area);
    st.user = true;
    this._runTreeApply(root);
  },

  /**
   * FR-ITC-15·16: 오른쪽 위의 반투명 미니맵과 줌 게이지.
   * UX_BATCH12_SRS FR-RMM-1·2: 미니맵은 트리를 줄인 것이다 — 간선과, 본 트리와 같은 상태
   * 클래스를 단 노드 상자를 그린다. 트리가 다시 그려지면 이 HUD 도 함께 새로 선다(FR-RMM-4).
   * 보기 상자는 테두리만이라 노드를 가리지 않는다.
   */
  _runTreeHud(nodes, lay) {
    const hud = runDiv('run-tree-hud');
    const mini = runSvg('svg', { class: 'run-tree-mini', viewBox: `0 0 ${lay.w} ${lay.h}` });
    for (const [p, c] of lay.edges) mini.appendChild(runSvg('path', { class: 'run-tree-mini-edge', d: runTreeEdgePath(lay.pos[p], lay.pos[c]) }));
    nodes.forEach((n, i) => {
      const kind = runNodeKind(n.state);
      mini.appendChild(runSvg('rect', {
        class: 'run-tree-mini-node state-' + (n.state || 'starting') + (kind === 'active' ? '' : ' ' + kind),
        x: lay.pos[i].x - RUN_TREE_NODE_W / 2, y: lay.pos[i].y, width: RUN_TREE_NODE_W, height: lay.pos[i].h,
      }));
    });
    mini.appendChild(runSvg('rect', { class: 'run-tree-mini-view' }));
    hud.appendChild(mini);
    const gauge = runDiv('run-tree-gauge');
    const zoom = document.createElement('input');
    zoom.type = 'range';
    zoom.className = 'run-tree-zoom';
    zoom.title = t('runs.tree_zoom');
    gauge.appendChild(zoom);
    gauge.appendChild(runDiv('run-tree-pct'));
    gauge.appendChild(UIKit.button({ label: t('runs.tree_fit'), title: t('runs.tree_fit_title'), size: 'sm', cls: 'run-tree-fit' }));
    hud.appendChild(gauge);
    return hud;
  },

  /** FR-ITC-13~16: 휠 줌 · 끌기 패닝 · 미니맵 · 게이지. 트리 영역이 새로 설 때마다 한 번 붙는다. */
  _runTreeWire(root, wrap, svg) {
    const st = () => root._treeCam;
    // UX_BATCH12_SRS FR-RMM-5 (FR-ITC-13 개정): 영역이 Run 화면의 50% 로 고정이라 수식키 없는 휠도
    // 줌이다. 영역 밖의 휠은 화면을 스크롤한다(FR-RMM-6).
    wrap.addEventListener('wheel', e => {
      if (!st()) return;
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      this._runTreeMove(root, runCamZoomAt(st().cam, Math.exp(-e.deltaY * RUN_TREE_WHEEL), e.clientX - r.left, e.clientY - r.top, st().range));
    }, { passive: false });

    let drag = null;
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !st()) return;
      drag = { x: e.clientX, y: e.clientY, cam: st().cam, moved: false, id: e.pointerId };
    });
    svg.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) <= RUN_TREE_DRAG_PX) return;
      if (!drag.moved) { drag.moved = true; svg.setPointerCapture(e.pointerId); svg.classList.add('panning') }
      this._runTreeMove(root, runCamPan(drag.cam, dx, dy));
    });
    const end = () => {
      if (drag && drag.moved) { svg.classList.remove('panning'); svg._noClick = true }
      drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    // 끌기를 마친 누름은 노드 클릭이 아니다 (FR-ITC-14). 캡처 단계에서 노드보다 먼저 받는다.
    svg.addEventListener('click', e => {
      if (!svg._noClick) return;
      svg._noClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    const mini = wrap.querySelector('.run-tree-mini');
    const toTree = e => new DOMPoint(e.clientX, e.clientY).matrixTransform(mini.getScreenCTM().inverse());
    // UX_BATCH12_SRS FR-RMM-3: 상자 안을 잡으면 잡은 거리를 지키며 끌고, 밖이면 그 점을 가운데로 옮긴 뒤 따라온다.
    let grab = null;
    mini.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !st()) return;
      e.stopPropagation();
      mini.setPointerCapture(e.pointerId);
      grab = runCamGrab(st().cam, st().area, toTree(e));
      this._runTreeMove(root, grab.cam);
    });
    mini.addEventListener('pointermove', e => {
      if (!grab || !mini.hasPointerCapture(e.pointerId)) return;
      this._runTreeMove(root, runCamDragTo(grab.cam, grab.off, toTree(e)));
    });
    const release = () => { grab = null };
    mini.addEventListener('pointerup', release);
    mini.addEventListener('pointercancel', release);

    wrap.querySelector('.run-tree-zoom').addEventListener('input', e => {
      if (!st()) return;
      const a = st().area;
      this._runTreeMove(root, runCamZoomAt(st().cam, Number(e.target.value) / 100 / st().cam.s, a.w / 2, a.h / 2, st().range));
    });
    wrap.querySelector('.run-tree-fit').addEventListener('click', () => {
      if (!st()) return;
      st().user = false;
      this._runTreeCam(root);
    });
  },

  /**
   * FR-ITC-7: 이슈 번호 · 제목 / 사슬 이름 / 상태 · 맥락 · 잎.
   * RUN_INACTIVE_NODE_SRS FR-RIN-1~3: 끝난 노드는 작은 상자에 머리 한 줄만, 잃은 노드는 눈에
   * 띄는 표시에 맥락 없이 그린다. 둘 다 누를 수 없다 — 붙일 도구가 없어 누르면 실패했다.
   */
  _runTreeNodeEl(n, p) {
    const kind = runNodeKind(n.state);
    const active = kind === 'active';
    const cls = 'run-tree-node state-' + (n.state || 'starting') + (n.leaf ? ' leaf' : '')
      + (active ? '' : ' inactive ' + kind);
    const g = runSvg('g', active ? { class: cls, role: 'button', tabindex: '0' } : { class: cls });
    g.dataset.member = n.id;
    g.dataset.depth = String(p.depth);
    const x = p.x - RUN_TREE_NODE_W / 2;
    const tip = runSvg('title');
    tip.textContent = [runTreeIssueNumber(n.issue), n.title, n.role, n.state, active ? t('runs.tree_jump') : '']
      .filter(Boolean).join(' · ');
    g.appendChild(tip);
    g.appendChild(runSvg('rect', { class: 'run-tree-box', x, y: p.y, width: RUN_TREE_NODE_W, height: p.h, rx: 5 }));

    const tx = x + RUN_TREE_PAD_IN;
    const head = runSvg('text', { x: tx, y: p.y + (kind === 'ended' ? 19 : 20) });
    const num = runTreeIssueNumber(n.issue);
    if (num) head.appendChild(runTreeSpan('run-tree-issue', num));
    if (n.title) {
      const s = runTreeSpan('run-tree-title', runTreeClip(n.title, RUN_TREE_TEXT_UNITS - (num ? num.length + 1 : 0)));
      if (num) s.setAttribute('dx', '6');
      head.appendChild(s);
    }
    if (head.childNodes.length) g.appendChild(head);
    if (kind === 'ended') return g;
    const role = runSvg('text', { class: 'run-tree-role', x: tx, y: p.y + 37 });
    role.textContent = runTreeClip(n.role || '', RUN_TREE_TEXT_UNITS);
    g.appendChild(role);
    const foot = runSvg('text', { x: tx, y: p.y + 54 });
    foot.appendChild(runTreeSpan('run-tree-state', n.state || ''));
    if (active && n.contextRatio) foot.appendChild(runTreeSpan('run-tree-ctx', Math.round(n.contextRatio * 100) + '%', '8'));
    if (n.leaf) foot.appendChild(runTreeSpan('run-tree-leaf', t('runs.tree_leaf'), '8'));
    g.appendChild(foot);
    if (!active) return g;

    const go = () => this._runJumpToMember(n);
    g.addEventListener('click', go);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } });
    return g;
  },

  /** FR-ITC-8: 트리 Run 의 카드는 트리 순서(깊이 우선)다. 트리에 없는 멤버는 뒤에 그대로 둔다. */
  _runTreeOrder(members, tree) {
    if (!tree || !tree.nodes || !tree.nodes.length) return members;
    const rank = new Map(tree.nodes.map((n, i) => [n.id, i]));
    const at = m => (rank.has(m.id) ? rank.get(m.id) : rank.size);
    return members.slice().sort((a, b) => at(a) - at(b));
  },
});

/** 흔적으로만 남는 노드의 상태 (FR-ITC-3·7). */
const RUN_TREE_ENDED = new Set(['done', 'failed', 'released']);

/**
 * RUN_INACTIVE_NODE_SRS: 노드·카드의 종류. `ended`(끝남)·`lost`(잃음)는 비활성이다. 상태는
 * 서버의 것이므로, 잃은 멤버의 도구가 다시 잡히면 다음 응답에서 `active` 로 돌아온다 (FR-RIN-20).
 */
function runNodeKind(state) {
  if (RUN_TREE_ENDED.has(state)) return 'ended';
  return state === 'lost' ? 'lost' : 'active';
}

/** FR-RIN-10: 카드 목록에는 끝난 멤버를 싣지 않는다. 잃은 멤버는 남는다(FR-RIN-11). */
function runCardsShown(members) {
  return members.filter(m => runNodeKind(m.state) !== 'ended');
}

// FR-ITC-10: 트리 다이어그램의 치수. 전부 viewBox 좌표다 — 같은 트리는 어느 창에서도 같은 모양이다.
const RUN_TREE_NODE_W = 184;
const RUN_TREE_NODE_H = 64;
// FR-RIN-1: 끝난 노드의 상자 높이 — 머리 한 줄이 든다.
const RUN_TREE_NODE_H_ENDED = 30;
const RUN_TREE_GAP_X = 24;
const RUN_TREE_GAP_Y = 44;
const RUN_TREE_PAD = 12;
const RUN_TREE_PAD_IN = 10;
// 상자 한 줄에 드는 폭(반각 글자 칸). 한글 같은 전각 글자는 두 칸으로 센다.
const RUN_TREE_TEXT_UNITS = 26;
// FR-ITC-11: 보기 영역의 높이 — Run 화면 높이에 대한 비율.
const RUN_TREE_AREA_RATIO = 0.5;
// FR-ITC-13: 휠 한 단위(deltaY 1)의 줌 세기. 배율은 exp(-deltaY × 이 값) 배다.
const RUN_TREE_WHEEL = 0.002;
// FR-ITC-14: 이보다 많이 끌어야 패닝이다. 그 아래는 노드 클릭으로 남는다.
const RUN_TREE_DRAG_PX = 4;

/**
 * FR-ITC-10: 노드 목록(깊이 우선)만으로 배치를 정한다. 잎은 가로 칸을 하나씩 받고,
 * 부모는 첫 자식과 끝 자식의 가운데에 선다. 부모가 목록에 없는 노드는 루트다.
 * `pos[i]` 는 i 번째 노드의 {x(가운데), y(위), depth}, `edges` 는 [부모, 자식] 자리 쌍이다.
 */
function runTreeLayout(nodes) {
  if (!nodes.length) return { w: 0, h: 0, pos: [], edges: [] };
  const byRole = new Map();
  nodes.forEach((n, i) => { if (!byRole.has(n.role)) byRole.set(n.role, i) });
  const kids = nodes.map(() => []);
  const roots = [];
  nodes.forEach((n, i) => {
    const p = n.parent ? byRole.get(n.parent) : undefined;
    if (p === undefined || p === i) roots.push(i); else kids[p].push(i);
  });
  const pos = new Array(nodes.length);
  const edges = [];
  const step = RUN_TREE_NODE_W + RUN_TREE_GAP_X;
  let slot = 0, maxDepth = 0;
  const place = (i, depth) => {
    pos[i] = { x: 0, y: RUN_TREE_PAD + depth * (RUN_TREE_NODE_H + RUN_TREE_GAP_Y), depth,
      h: runNodeKind(nodes[i].state) === 'ended' ? RUN_TREE_NODE_H_ENDED : RUN_TREE_NODE_H };
    maxDepth = Math.max(maxDepth, depth);
    const ks = kids[i].filter(k => !pos[k]);
    for (const k of ks) { edges.push([i, k]); place(k, depth + 1) }
    pos[i].x = ks.length
      ? (pos[ks[0]].x + pos[ks[ks.length - 1]].x) / 2
      : RUN_TREE_PAD + RUN_TREE_NODE_W / 2 + (slot++) * step;
  };
  for (const r of roots) place(r, 0);
  // 부모 고리로 루트에 닿지 못한 노드도 버리지 않는다 — 루트로 세운다.
  nodes.forEach((_, i) => { if (!pos[i]) place(i, 0) });
  return {
    w: RUN_TREE_PAD * 2 + slot * step - RUN_TREE_GAP_X,
    h: RUN_TREE_PAD * 2 + (maxDepth + 1) * (RUN_TREE_NODE_H + RUN_TREE_GAP_Y) - RUN_TREE_GAP_Y,
    pos, edges,
  };
}

/** 부모 상자 아래 → 두 줄 사이 → 자식 상자 위로 꺾여 내려가는 선. 상자 높이는 노드마다다 (FR-RIN-4). */
function runTreeEdgePath(p, c) {
  const y1 = p.y + p.h, y2 = c.y, my = (y1 + y2) / 2;
  return `M${p.x},${y1} V${my} H${c.x} V${y2}`;
}

function runTreeSpan(cls, text, dx) {
  const s = runSvg('tspan', { class: cls });
  if (dx) s.setAttribute('dx', dx);
  s.textContent = text;
  return s;
}

/** 폭(반각 칸)을 넘으면 줄이고 끝에 … 를 붙인다. 전각 글자는 두 칸이다. */
function runTreeClip(text, units) {
  const w = ch => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1);
  const chars = Array.from(text || '');
  if (chars.reduce((s, ch) => s + w(ch), 0) <= units) return text || '';
  let out = '', used = 0;
  for (const ch of chars) {
    if (used + w(ch) > units - 1) break;
    out += ch;
    used += w(ch);
  }
  return out + '…';
}

/** `owner/repo#33` → `#33`. 배정이 없는 옛 노드는 빈 값이다. */
function runTreeIssueNumber(issue) {
  const i = (issue || '').lastIndexOf('#');
  return i < 0 ? '' : issue.slice(i);
}
