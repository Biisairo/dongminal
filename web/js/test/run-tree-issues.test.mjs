import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * UX_BATCH14_SRS FR-ITV-3·5·6~9 (TC-UB14-7·8·9): 이슈 원천과 Run 멤버를 한 트리로 합치기.
 */
const ctx = load(['core/screens.js', 'ui/runs-panel.js', 'ui/run-tree.js', 'ui/run-tree-issues.js'], {
  globals: { t: (k) => k, panesOf: () => [] },
  expose: ['runIssueKey', 'runTreeMerge', 'runMemberSig', 'runIssueWatchDirs', 'runIssueFsHit', 'runTreeLayout',
    'RUN_TREE_NODE_W', 'RUN_TREE_NODE_H_ISSUE', 'RUN_COORD'],
});
const plain = (x) => JSON.parse(JSON.stringify(x));

test('이슈 열쇠: GitHub 은 소문자, 로컬은 별칭을 뗀 ID', () => {
  assert.equal(ctx.runIssueKey('github', 'O/R#12'), 'o/r#12');
  assert.equal(ctx.runIssueKey('local', 'trial:1.2'), '1.2');
  assert.equal(ctx.runIssueKey('local', '1.2'), '1.2');
  assert.equal(ctx.runIssueKey('github', ''), '');
});

const gh = {
  storage: 'github',
  issues: [
    { key: 'o/r#1', num: '#1', title: 'root', state: 'open', parent: '', url: 'u1' },
    { key: 'o/r#2', num: '#2', title: 'a', state: 'open', parent: 'o/r#1', url: 'u2' },
    { key: 'o/r#3', num: '#3', title: 'b', state: 'closed', parent: 'o/r#1', url: 'u3' },
  ],
};
const member = (id, role, parent, issue, state = 'working') => ({ id, role, parent, issue, state, runId: 'R1' });

test('TC-UB14-9: 이슈마다 노드 하나 — 배정된 멤버는 그 이슈 자리에 붙고, 나머지는 이슈 노드다', () => {
  const out = plain(ctx.runTreeMerge([member('m2', 'r›2', 'r', 'O/R#2')], gh));
  assert.deepEqual(out.map((n) => n.tid), ['issue:o/r#1', 'issue:o/r#2', 'issue:o/r#3']);
  assert.deepEqual(out.map((n) => n.tparent), ['', 'issue:o/r#1', 'issue:o/r#1']);
  assert.equal(out[1].id, 'm2');
  assert.equal(out[1].linked, true);
  assert.equal(out[1].role, 'r›2', '멤버의 보이는 값은 그대로다');
  assert.equal(out[1].num, '#2');
  assert.equal(out[1].title, 'a', '멤버 기록에 제목이 없으면 이슈의 제목이다');
  assert.equal(out[0].issueNode, true);
  assert.equal(out[2].istate, 'closed');
  assert.equal(out[2].url, 'u3');
});

test('TC-UB14-9: 조정자는 루트 위에 서고, 이슈가 없는 멤버는 역할 사슬대로 붙는다', () => {
  const coord = { id: ctx.RUN_COORD, role: ctx.RUN_COORD, coord: true, parent: '', state: '' };
  const nodes = [coord, member('m2', 'r›2', ctx.RUN_COORD, 'o/r#2'), member('w', 'r›2›w', 'r›2', ''), member('x', 'x', ctx.RUN_COORD, '')];
  const out = plain(ctx.runTreeMerge(nodes, gh));
  const by = Object.fromEntries(out.map((n) => [n.id, n]));
  assert.equal(out[0].id, ctx.RUN_COORD);
  assert.equal(by['issue:o/r#1'].tparent, ctx.RUN_COORD);
  assert.equal(by.w.tparent, 'issue:o/r#2', '이슈 자리로 옮긴 멤버의 자식은 그 자리를 따라간다');
  assert.equal(by.x.tparent, ctx.RUN_COORD);
  const l = ctx.runTreeLayout(out);
  assert.equal(l.pos[0].depth, 0);
  assert.equal(l.pos[out.findIndex((n) => n.id === 'w')].depth, 3);
});

test('TC-UB14-9: 한 이슈에 멤버가 여럿이면 살아 있는 멤버가 그 자리에 선다', () => {
  const out = plain(ctx.runTreeMerge([member('old', 'r›2', 'r', 'o/r#2', 'done'), member('new', 'r›2b', 'r', 'o/r#2', 'working')], gh));
  assert.equal(out.find((n) => n.tid === 'issue:o/r#2').id, 'new');
  assert.ok(out.some((n) => n.id === 'old' && n.tid === 'r›2'), '자리를 받지 못한 멤버도 버리지 않는다');
});

test('FR-ITV-10: 이슈가 없거나 실패면 멤버 트리 그대로다', () => {
  const nodes = [member('m', 'r', '', 'o/r#1')];
  assert.equal(ctx.runTreeMerge(nodes, null), nodes);
  assert.equal(ctx.runTreeMerge(nodes, { storage: 'github', issues: [], error: 'gh_failed' }), nodes);
});

test('이슈 노드는 보통 폭에 이슈 높이를 받는다', () => {
  const out = ctx.runTreeMerge([], gh);
  const l = ctx.runTreeLayout(out);
  assert.equal(l.pos[0].w, ctx.RUN_TREE_NODE_W);
  assert.equal(l.pos[0].h, ctx.RUN_TREE_NODE_H_ISSUE);
});

test('TC-UB14-7: 멤버 서명은 구성·상태·배정만 본다(맥락 % 는 보지 않는다)', () => {
  const a = [{ id: 'a', state: 'working', issue: 'o/r#1', contextRatio: 0.1 }];
  const b = [{ id: 'a', state: 'working', issue: 'o/r#1', contextRatio: 0.9 }];
  assert.equal(ctx.runMemberSig(a), ctx.runMemberSig(b));
  assert.notEqual(ctx.runMemberSig(a), ctx.runMemberSig([{ ...a[0], state: 'done' }]));
  assert.notEqual(ctx.runMemberSig(a), ctx.runMemberSig([...a, { id: 'b', state: 'working', issue: '' }]));
});

test('TC-UB14-8: 보이는 로컬 트리의 이슈 폴더만 감시하고, 그 폴더의 변화가 그 뷰를 고른다', () => {
  const views = [
    { key: 'v1', tree: { storage: 'local', issueDir: '/repo/trial/issues' } },
    { key: 'v2', tree: { tree: 'o/r#1' } },
    { key: 'v3', tree: { storage: 'local', issueDir: '/repo/trial/issues' } },
    { key: 'v4', tree: null },
  ];
  assert.deepEqual([...ctx.runIssueWatchDirs(views)], ['/repo/trial/issues']);
  assert.deepEqual([...ctx.runIssueFsHit(views, ['/repo/trial/issues/1.2-b.md']).map((v) => v.key)], ['v1', 'v3']);
  assert.deepEqual([...ctx.runIssueFsHit(views, ['/repo/trial/issues2/x.md', '/other'])], []);
});
