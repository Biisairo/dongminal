/**
 * Run 대시보드 이슈 트리의 이슈 원천 (UX_BATCH14_SRS 묶음 I, FR-ITV-3·5·6~10).
 * 서버 `/api/runs/issue-tree` 가 준 이슈 목록과 Run 멤버를 한 트리로 합치고, 이슈만 있는 노드를 그린다.
 * `run-tree.js` 의 증강 분할이다 — 그 파일이 500줄 경계를 넘지 않게 갈랐다(FR-STR-40).
 */

/** FR-ITV-6: 이슈 열쇠. GitHub 은 `owner/repo#N` 을 소문자로, 로컬은 `<별칭>:` 을 뗀 ID 다. */
function runIssueKey(storage, s) {
  const v = String(s || '').trim();
  if (!v) return '';
  return storage === 'local' ? v.replace(/^[^:#]*:/, '') : v.toLowerCase();
}

/**
 * FR-ITV-6~10: 노드 목록(조정자 포함)에 이슈 원천을 입힌다. 배치는 `tid`·`tparent` 를 따른다.
 * 이슈마다 노드 하나 — 배정된 멤버(살아 있는 쪽 먼저)는 그 자리에 `linked` 로 서고, 나머지는 이슈 노드다.
 * 자리를 받지 못한 멤버는 역할 사슬대로 붙는다(FR-ITV-9). 이슈가 없거나 실패면 그대로 돌려준다(FR-ITV-10).
 */
function runTreeMerge(nodes, src) {
  if (!src || !Array.isArray(src.issues) || !src.issues.length) return nodes;
  const st = src.storage;
  const coord = nodes.find(n => n.coord);
  const byKey = new Map();
  for (const n of nodes) {
    const k = n.coord ? '' : runIssueKey(st, n.issue);
    if (!k) continue;
    const cur = byKey.get(k);
    if (!cur || (runNodeKind(cur.state) !== 'active' && runNodeKind(n.state) === 'active')) byKey.set(k, n);
  }
  const top = coord ? coord.role : '';
  const out = coord ? [Object.assign({}, coord, { tid: coord.role, tparent: '' })] : [];
  const tidOf = new Map();
  for (const i of src.issues) {
    const k = runIssueKey(st, i.key);
    const tid = 'issue:' + k;
    const tparent = i.parent ? 'issue:' + runIssueKey(st, i.parent) : top;
    const m = byKey.get(k);
    if (m) {
      tidOf.set(m.role, tid);
      // 멤버 기록에 제목이 없으면 이슈의 것을 보인다. 번호는 이슈 원천의 꼴(`#N`·로컬 ID)이다.
      out.push(Object.assign({}, m, { tid, tparent, linked: true, num: i.num || '', title: m.title || i.title || '' }));
    } else {
      out.push({ id: tid, issueNode: true, tid, tparent, issue: i.key, num: i.num || '', title: i.title || '',
        istate: i.state || '', url: i.url || '', path: i.path || '' });
    }
  }
  const placed = new Set(src.issues.map(i => byKey.get(runIssueKey(st, i.key))).filter(Boolean));
  for (const n of nodes) {
    if (n.coord || placed.has(n)) continue;
    out.push(Object.assign({}, n, { tid: n.role, tparent: tidOf.get(n.parent) || n.parent }));
  }
  return out;
}

/** FR-ITV-3: 이슈를 다시 읽을 계기 — 멤버 구성·상태·배정. 맥락 % 같은 잦은 값은 보지 않는다. */
function runMemberSig(members) {
  return JSON.stringify((members || []).map(m => [m.id, m.state || '', m.issue || '']).sort());
}

/** FR-ITV-5: 보이는 로컬 트리의 이슈 폴더. */
function runIssueWatchDirs(views) {
  const set = new Set();
  for (const v of views) if (v && v.tree && v.tree.storage === 'local' && v.tree.issueDir) set.add(v.tree.issueDir);
  return [...set].sort();
}

/** FR-ITV-5: 바뀐 경로가 그 이슈 폴더 안인 뷰. */
function runIssueFsHit(views, paths) {
  const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');
  return views.filter(v => v && v.tree && v.tree.storage === 'local' && v.tree.issueDir
    && paths.some(p => typeof p === 'string' && inside(v.tree.issueDir, p)));
}

Object.assign(RunsPanel.prototype, {
  /** FR-ITV-1: 트리의 이슈. 실패하면 null — 대시보드는 멤버만 그린다. */
  async _runIssuesGet(ref, refresh) {
    const r = await apiGet(RUNS_ISSUE_TREE_API + '?ref=' + encodeURIComponent(ref) + (refresh ? '&refresh=1' : ''));
    return r.ok ? r.data : null;
  },

  /**
   * FR-ITV-3 (D-UB14-8): 그 뷰가 트리를 처음 그릴 때와 멤버 구성·상태·배정이 바뀌었을 때만 다시 읽는다.
   * GitHub 은 그때만 gh 를 부르고, 로컬은 폴더 감시(FR-ITV-5)를 맞춘다.
   */
  async _runIssuesSync(v, tree) {
    if (!tree || !tree.tree) { v.issues = null; v.issueRef = null; v.issueSig = null; return }
    const sig = runMemberSig(tree.nodes);
    if (v.issueRef === tree.tree && v.issueSig === sig) return;
    const first = v.issueRef !== tree.tree;
    v.issueRef = tree.tree; v.issueSig = sig;
    v.issues = await this._runIssuesGet(tree.tree, true);
    if (first && this.app.editor && this.app.editor.watch) this.app.editor.watch.edWatchSync();
  },

  /** FR-ITV-3 ③: 새로고침 단추. */
  async _runIssuesRefresh(v) {
    if (!v.issueRef) return;
    v.issues = await this._runIssuesGet(v.issueRef, true);
    if (this._runViewMap().has(v.key)) this._runPaint(v);
  },

  /** FR-ITV-5: `EditorWatch` 가 감시 목록에 더한다. */
  _runIssueWatchDirs() {
    return runIssueWatchDirs([...this._runViewMap().values()]);
  },

  /** FR-ITV-5: `fs` 사건 — 그 이슈 폴더를 보이는 뷰만 다시 읽는다. */
  _runIssueFsChanged(paths) {
    for (const v of runIssueFsHit([...this._runViewMap().values()], paths)) this._runIssuesRefresh(v);
  },

  /** FR-ITV-8: 이슈 노드 — 번호·제목 / 상태. 누르면 GitHub 이슈는 브라우저로, 로컬 이슈는 편집기로 연다. */
  _runTreeIssueEl(n, p) {
    const g = svgEl('g', { class: 'run-tree-node issue istate-' + (n.istate || 'unknown'), role: 'button', tabindex: '0' });
    g.dataset.issue = n.issue;
    g.dataset.depth = String(p.depth);
    const x = p.x - p.w / 2, tx = x + RUN_TREE_PAD_IN;
    const tip = svgEl('title');
    tip.textContent = [n.num, n.title, n.istate, t('runs.tree_issue_open')].filter(Boolean).join(' · ');
    g.appendChild(tip);
    g.appendChild(svgEl('rect', { class: 'run-tree-box', x, y: p.y, width: p.w, height: p.h, rx: 5 }));
    const head = svgEl('text', { x: tx, y: p.y + 19 });
    if (n.num) head.appendChild(runTreeSpan('run-tree-issue', n.num));
    const s = runTreeSpan('run-tree-title', runTreeClip(n.title, RUN_TREE_TEXT_UNITS - (n.num ? n.num.length + 1 : 0)));
    if (n.num) s.setAttribute('dx', '6');
    head.appendChild(s);
    g.appendChild(head);
    const foot = svgEl('text', { x: tx, y: p.y + 37 });
    foot.appendChild(runTreeSpan('run-tree-state', n.istate || ''));
    g.appendChild(foot);
    const open = () => {
      if (n.url) window.open(n.url, '_blank', 'noopener');
      else if (n.path && this.app.editor && this.app.editor.file) this.app.editor.file.edOpenFile(n.path, {});
    };
    g.addEventListener('click', open);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } });
    return g;
  },
});
