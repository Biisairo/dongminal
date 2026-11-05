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
    const sig = tree ? JSON.stringify(nodes.map(n => [n.role, n.state, n.leaf, n.contextRatio || 0])) : '';
    paintIfChanged(el, sig, () => {
      el.textContent = '';
      if (!tree) return;
      el.appendChild(runDiv('run-tree-h', t('runs.tree_title', {ref: tree.tree})));
      if (!nodes.length) { el.appendChild(runDiv('run-tree-empty', t('runs.tree_empty'))); return }
      const depth = {};
      for (const n of nodes) {
        const d = n.parent ? (depth[n.parent] || 0) + 1 : 0;
        depth[n.role] = d;
        const row = runDiv('run-tree-node state-' + (n.state || 'starting') + (n.leaf ? ' leaf' : ''));
        row.style.setProperty('--depth', String(d));
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.dataset.member = n.id;
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
});
