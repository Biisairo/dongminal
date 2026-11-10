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
      const wrap = runDiv('run-tree-wrap ui-scroll');
      wrap.appendChild(svg);
      el.appendChild(wrap);
    });
    runFitSvg(el, el.querySelector('.run-tree-svg'));
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
