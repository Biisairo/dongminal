/**
 * Run 대시보드의 「이슈 트리」 영역 (ISSUE_AGENT_TREE_SRS 묶음 D).
 * `run-dashboard.js` 의 증강 분할이다 — 그 파일이 500줄 경계를 넘지 않게 갈랐다(FR-STR-40).
 */
Object.assign(RunsPanel.prototype, {
  /**
   * ISSUE_AGENT_TREE_SRS FR-ITD-1~4: 이슈 트리. 노드 = 그 트리의 열린 Run 들의 멤버이고,
   * 부모·잎은 서버가 사슬 이름에서 정했다. 누르면 그 에이전트의 탭으로 간다.
   * ISSUE_TREE_OPS_SRS FR-ITC-6·10: 도형 다이어그램(SVG)이다. UX_BATCH14_SRS FR-ITV-11 로 왼쪽→오른쪽이다(이전: 위→아래).
   */
  _runPaintTree(root, tree, d, issues, refresh) {
    const el = root.querySelector('.run-tree');
    const members = (tree && tree.nodes) || [];
    // RUN_RECOVERY_SRS FR-RRC-40: 평평한 그래프가 숨으므로 조정자는 트리의 루트로 선다.
    // UX_BATCH14_SRS FR-ITV-6: 이슈 원천이 있으면 그 구조로 그리고 멤버를 이슈 자리에 붙인다(`run-tree-issues.js`).
    const nodes = runTreeMerge(runTreeWithCoord(members, runCoordItem(d)), issues);
    el.classList.toggle('vis', !!tree);
    // ISSUE_TREE_OPS_SRS FR-ITC-6: 트리 Run 은 평평한 그래프 대신 트리가 중심이다.
    root.classList.toggle('tree-run', !!tree);
    const nodeSig = n => [n.id, n.role, n.parent, n.state, n.leaf, n.contextRatio || 0, n.issue || '', n.title || '', n.agent || '',
      n.recoverable ? 1 : 0, n.tid || '', n.tparent || '', n.istate || '', n.linked ? 1 : 0];
    const sig = tree ? JSON.stringify([issues ? [issues.error || '', issues.message || ''] : null, nodes.map(nodeSig)]) : '';
    paintIfChanged(el, sig, () => {
      el.textContent = '';
      if (!tree) return;
      el.appendChild(domEl('div', 'run-tree-h', t('runs.tree_title', {ref: tree.tree})));
      // FR-ITV-3 ③·FR-ITV-10: 이슈 새로고침 단추와 읽지 못한 까닭.
      if (issues && refresh) {
        const bar = el.appendChild(domEl('div', 'run-tree-bar'));
        bar.appendChild(UIKit.button({ label: t('runs.tree_refresh'), title: t('runs.tree_refresh_title'), size: 'sm', cls: 'run-tree-refresh', onClick: refresh }));
        if (issues.error) bar.appendChild(domEl('span', 'run-tree-err', t('runs.tree_issue_err', { msg: issues.message || issues.error })));
      }
      if (!nodes.length) { el.appendChild(domEl('div', 'run-tree-empty', t('runs.tree_empty'))); return }
      const lay = runTreeLayout(nodes);
      const svg = svgEl('svg', { class: 'run-tree-svg', viewBox: `0 0 ${lay.w} ${lay.h}` });
      svg.dataset.w = lay.w;
      svg.dataset.h = lay.h;
      const edges = svgEl('g', { class: 'run-tree-edges' });
      for (const [p, c] of lay.edges) edges.appendChild(svgEl('path', { class: 'run-tree-edge', d: runTreeEdgePath(lay.pos[p], lay.pos[c]) }));
      svg.appendChild(edges);
      nodes.forEach((n, i) => svg.appendChild(this._runTreeNodeEl(n, lay.pos[i])));
      // FR-ITC-11: 높이가 고정된 보기 영역. 줌·패닝은 viewBox 만 바꾼다 (`_runTreeCam`).
      const wrap = domEl('div', 'run-tree-wrap');
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
    const hud = domEl('div', 'run-tree-hud');
    const mini = svgEl('svg', { class: 'run-tree-mini', viewBox: `0 0 ${lay.w} ${lay.h}` });
    for (const [p, c] of lay.edges) mini.appendChild(svgEl('path', { class: 'run-tree-mini-edge', d: runTreeEdgePath(lay.pos[p], lay.pos[c]) }));
    nodes.forEach((n, i) => {
      const kind = runNodeKind(n.state);
      mini.appendChild(svgEl('rect', {
        class: n.issueNode ? 'run-tree-mini-node issue' : 'run-tree-mini-node state-' + (n.state || 'starting') + (kind === 'active' ? '' : ' ' + kind),
        x: lay.pos[i].x - lay.pos[i].w / 2, y: lay.pos[i].y, width: lay.pos[i].w, height: lay.pos[i].h,
      }));
    });
    mini.appendChild(svgEl('rect', { class: 'run-tree-mini-view' }));
    hud.appendChild(mini);
    const gauge = domEl('div', 'run-tree-gauge');
    const zoom = document.createElement('input');
    zoom.type = 'range';
    zoom.className = 'run-tree-zoom';
    zoom.title = t('runs.tree_zoom');
    gauge.appendChild(zoom);
    gauge.appendChild(domEl('div', 'run-tree-pct'));
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
    if (n.issueNode) return this._runTreeIssueEl(n, p);
    const kind = runNodeKind(n.state);
    const active = kind === 'active';
    const cls = 'run-tree-node ' + (n.coord ? 'coord' : 'state-' + (n.state || 'starting')) + (n.leaf ? ' leaf' : '')
      + (active ? '' : ' inactive ' + kind) + (n.linked ? ' linked' : '');
    const g = svgEl('g', active ? { class: cls, role: 'button', tabindex: '0' } : { class: cls });
    g.dataset.member = n.id;
    g.dataset.depth = String(p.depth);
    const x = p.x - p.w / 2;
    const tip = svgEl('title');
    tip.textContent = [n.num || runTreeIssueNumber(n.issue), n.title, n.coord ? n.agent : n.role, n.state, active ? t('runs.tree_jump') : '']
      .filter(Boolean).join(' · ');
    g.appendChild(tip);
    g.appendChild(svgEl('rect', { class: 'run-tree-box', x, y: p.y, width: p.w, height: p.h, rx: 5 }));

    const tx = x + RUN_TREE_PAD_IN;
    const head = svgEl('text', { x: tx, y: p.y + (kind === 'ended' ? 19 : 20) });
    const num = n.num || runTreeIssueNumber(n.issue);   // UX_BATCH14_SRS FR-ITV-7: 이슈 원천을 입힌 노드는 그 번호다
    if (num) head.appendChild(runTreeSpan('run-tree-issue', num));
    if (n.title) {
      // RUN_RECOVERY_SRS FR-RRC-31: 복구 단추가 오른쪽 위에 서면 그 폭만큼 제목을 줄인다.
      const units = (kind === 'ended' ? RUN_TREE_TEXT_UNITS_ENDED : RUN_TREE_TEXT_UNITS) - (n.recoverable ? RUN_TREE_RECOVER_UNITS : 0);
      const s = runTreeSpan('run-tree-title', runTreeClip(n.title, units - (num ? num.length + 1 : 0)));
      if (num) s.setAttribute('dx', '6');
      head.appendChild(s);
    }
    if (head.childNodes.length) g.appendChild(head);
    if (kind === 'ended') return g;
    const role = svgEl('text', { class: 'run-tree-role', x: tx, y: p.y + 37 });
    role.textContent = runTreeClip((n.coord ? n.agent : n.role) || '', RUN_TREE_TEXT_UNITS);
    g.appendChild(role);
    const foot = svgEl('text', { x: tx, y: p.y + 54 });
    foot.appendChild(runTreeSpan('run-tree-state', n.state || ''));
    if (active && n.contextRatio) foot.appendChild(runTreeSpan('run-tree-ctx', Math.round(n.contextRatio * 100) + '%', '8'));
    if (n.leaf) foot.appendChild(runTreeSpan('run-tree-leaf', t('runs.tree_leaf'), '8'));
    g.appendChild(foot);
    if (n.recoverable) g.appendChild(this._runTreeRecoverEl(n, p)); // RUN_RECOVERY_SRS FR-RRC-31
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

/** FR-RIN-10: 카드 목록에는 끝난 멤버를 싣지 않는다. 잃은 멤버는 남는다(FR-RIN-11). */
function runCardsShown(members) {
  return members.filter(m => runNodeKind(m.state) !== 'ended');
}

/**
 * RUN_RECOVERY_SRS FR-RRC-40·41: 조정자의 화면 항목. 조정자 도구가 없는 Run 에는 없다.
 * 관측(`coordinator`)을 얹어 멤버와 같은 규칙으로 그린다 (FR-RCX-8).
 */
function runCoordItem(d) {
  if (!d || !d.coordinatorToolId) return null;
  return Object.assign({}, d.coordinator || {}, {
    id: RUN_COORD, role: RUN_COORD, coord: true, state: '', parent: '',
    toolId: d.coordinatorToolId, agent: d.coordinatorAgent || '', title: t('runs.coordinator'),
    runId: d.runId, recoverable: !!d.coordinatorRecoverable,
  });
}

/**
 * FR-RRC-40: 조정자를 트리의 루트로 세운다. 이 Run 의 노드 가운데 부모가 목록에 없는 것이 그 자식이
 * 된다. 트리는 여러 Run 에 걸치므로 다른 Run 의 루트는 루트로 둔다.
 */
function runTreeWithCoord(nodes, coord) {
  if (!coord) return nodes;
  const roles = new Set(nodes.map(n => n.role));
  const under = n => n.runId === coord.runId && !(n.parent && roles.has(n.parent));
  return [coord, ...nodes.map(n => (under(n) ? Object.assign({}, n, { parent: coord.role }) : n))];
}

/** FR-RRC-41: 카드 목록 — 조정자 카드가 맨 앞이다. */
function runCardItems(d, members) {
  const coord = runCoordItem(d);
  const shown = runCardsShown(members);
  return coord ? [coord, ...shown] : shown;
}

// FR-ITC-10: 트리 다이어그램의 치수. 전부 viewBox 좌표다 — 같은 트리는 어느 창에서도 같은 모양이다.
const RUN_TREE_NODE_W = 184;
const RUN_TREE_NODE_H = 64;
// FR-RIN-1: 끝난 노드의 상자 높이 — 머리 한 줄이 든다.
const RUN_TREE_NODE_H_ENDED = 30;
// FR-RIN-5: 끝난 노드의 상자 폭과, 그 머리 한 줄에 드는 폭(반각 칸).
const RUN_TREE_NODE_W_ENDED = 112;
// UX_BATCH14_SRS FR-ITV-8: 에이전트가 없는 이슈 노드의 상자 높이 — 번호·제목 한 줄과 상태 한 줄이 든다.
const RUN_TREE_NODE_H_ISSUE = 46;
const RUN_TREE_TEXT_UNITS_ENDED = 14;
// FR-ITV-11: 열(깊이) 사이 — 꺾이는 선이 지나는 자리 — 와 같은 열의 상자 사이.
const RUN_TREE_GAP_X = 44;
const RUN_TREE_GAP_Y = 14;
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
 * FR-ITC-10: 노드 목록(깊이 우선)만으로 배치를 정한다. 부모가 목록에 없는 노드는 루트다.
 * UX_BATCH14_SRS FR-ITV-11 (D-UB14-11): 이전 — 위→아래였고 잎이 가로로 나란히 서서 큰 트리가 옆으로 너무 넓었다 /
 *   새 — 왼쪽→오른쪽이다. 깊이는 열이고, 잎은 세로 칸을 하나씩 받고, 부모는 첫 자식과 끝 자식의 세로 가운데에 선다 /
 *   이유 — 폭이 깊이에만 비례한다(사용자 결정).
 * RUN_INACTIVE_NODE_SRS FR-RIN-5: 칸 높이는 상자 높이다. 부모가 자식들보다 크면 가지를 민다.
 * `pos[i]` 는 i 번째 노드의 {x(가운데), y(위), depth, w, h}, `edges` 는 [부모, 자식] 자리 쌍이다.
 */
function runTreeLayout(nodes) {
  if (!nodes.length) return { w: 0, h: 0, pos: [], edges: [] };
  // UX_BATCH14_SRS FR-ITV-6: 이슈 원천을 입힌 노드는 `tid`·`tparent` 로 잇는다(`runTreeMerge`). 아니면 역할 사슬이다.
  const idOf = n => (n.tid !== undefined ? n.tid : n.role);
  const parentOf = n => (n.tparent !== undefined ? n.tparent : n.parent);
  const byRole = new Map();
  nodes.forEach((n, i) => { if (!byRole.has(idOf(n))) byRole.set(idOf(n), i) });
  const kids = nodes.map(() => []);
  const roots = [];
  nodes.forEach((n, i) => {
    const p = parentOf(n) ? byRole.get(parentOf(n)) : undefined;
    if (p === undefined || p === i) roots.push(i); else kids[p].push(i);
  });
  const pos = new Array(nodes.length);
  const edges = [];
  // 다음 칸이 시작하는 y. 노드 하나를 놓을 때마다 그 가지의 아래 끝 + 간격으로 옮긴다.
  let next = RUN_TREE_PAD, maxDepth = 0;
  const shift = (i, dy) => { pos[i].y += dy; for (const [p, c] of edges) if (p === i) shift(c, dy) };
  const mid = i => pos[i].y + pos[i].h / 2;
  const place = (i, depth) => {
    const issue = !!nodes[i].issueNode;
    const ended = !issue && runNodeKind(nodes[i].state) === 'ended';
    const w = ended ? RUN_TREE_NODE_W_ENDED : RUN_TREE_NODE_W;
    const h = issue ? RUN_TREE_NODE_H_ISSUE : ended ? RUN_TREE_NODE_H_ENDED : RUN_TREE_NODE_H;
    pos[i] = { x: RUN_TREE_PAD + depth * (RUN_TREE_NODE_W + RUN_TREE_GAP_X) + w / 2, y: 0, depth, w, h };
    maxDepth = Math.max(maxDepth, depth);
    const start = next;
    const ks = kids[i].filter(k => !pos[k]);
    for (const k of ks) { edges.push([i, k]); place(k, depth + 1) }
    if (!ks.length) { pos[i].y = start; next = start + h + RUN_TREE_GAP_Y; return }
    pos[i].y = (mid(ks[0]) + mid(ks[ks.length - 1])) / 2 - h / 2;
    const over = start - pos[i].y;
    if (over > 0) shift(i, over);
    next = Math.max(next, pos[i].y + h + RUN_TREE_GAP_Y);
  };
  for (const r of roots) place(r, 0);
  // 부모 고리로 루트에 닿지 못한 노드도 버리지 않는다 — 루트로 세운다.
  nodes.forEach((_, i) => { if (!pos[i]) place(i, 0) });
  return {
    w: RUN_TREE_PAD * 2 + (maxDepth + 1) * (RUN_TREE_NODE_W + RUN_TREE_GAP_X) - RUN_TREE_GAP_X,
    h: next - RUN_TREE_GAP_Y + RUN_TREE_PAD,
    pos, edges,
  };
}

/** FR-ITV-12: 부모 상자 오른쪽 → 두 열 사이 → 자식 상자 왼쪽으로 꺾이는 선. 상자 크기는 노드마다다 (FR-RIN-4). */
function runTreeEdgePath(p, c) {
  const x1 = p.x + p.w / 2, x2 = c.x - c.w / 2, mx = (x1 + x2) / 2;
  return `M${x1},${p.y + p.h / 2} H${mx} V${c.y + c.h / 2} H${x2}`;
}

/** SVG 글자 조각 하나 — `svgEl` 위에 선택 속성 `dx` 와 글자를 더한다. */
function runTreeSpan(cls, text, dx) {
  const s = svgEl('tspan', { class: cls });
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
