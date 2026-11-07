/**
 * Run 대시보드의 「이슈 트리」 영역 (ISSUE_AGENT_TREE_SRS 묶음 D).
 * `run-dashboard.js` 의 증강 분할이다 — 그 파일이 500줄 경계를 넘지 않게 갈랐다(FR-STR-40).
 */
Object.assign(RunsPanel.prototype, {
  /**
   * ISSUE_AGENT_TREE_SRS FR-ITD-1~4: 이슈 트리. 노드 = 그 트리의 열린 Run 들의 멤버이고,
   * 부모·잎은 서버가 사슬 이름에서 정했다. 누르면 그 에이전트의 탭으로 간다.
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
      const depth = {};
      for (const n of nodes) {
        const d = n.parent ? (depth[n.parent] || 0) + 1 : 0;
        depth[n.role] = d;
        const ended = RUN_TREE_ENDED.has(n.state);
        const row = runDiv('run-tree-node state-' + (n.state || 'starting') + (n.leaf ? ' leaf' : '') + (ended ? ' ended' : ''));
        row.style.setProperty('--depth', String(d));
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.dataset.member = n.id;
        // FR-ITC-7: 이슈 번호 · 제목 · 상태 · 맥락. 사슬 이름은 번호 옆에 흐리게 남긴다.
        const num = runTreeIssueNumber(n.issue);
        if (num) row.appendChild(runDiv('run-tree-issue', num));
        if (n.title) row.appendChild(runDiv('run-tree-title', n.title));
        row.appendChild(runDiv('run-tree-role', n.role));
        row.appendChild(runDiv('run-tree-state', n.state || ''));
        if (n.contextRatio) row.appendChild(runDiv('run-tree-ctx', Math.round(n.contextRatio * 100) + '%'));
        if (n.leaf) row.appendChild(runDiv('run-tree-leaf', t('runs.tree_leaf')));
        row.title = t('runs.tree_jump');
        const go = () => this._runJumpToMember(n);
        row.addEventListener('click', go);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } });
        el.appendChild(row);
      }
    });
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

/** `owner/repo#33` → `#33`. 배정이 없는 옛 노드는 빈 값이다. */
function runTreeIssueNumber(issue) {
  const i = (issue || '').lastIndexOf('#');
  return i < 0 ? '' : issue.slice(i);
}
