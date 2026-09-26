import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-1 — 편집기의 변경 표시(EdDirtyDiff)가 status 를 받는
 * 자리. 세는 것은 요청이다 (FR-OPT-0-4).
 *
 *   FEU-5: 문서마다 status 를 따로 받았다 → GitStatusHub 를 지난다
 *   FEU-4: stage() 가 gitSignal(→ 모든 문서 refresh) 뒤에 refresh 를 또 불렀다 → 한 번
 */
function setup() {
  const calls = { status: 0, diff: 0, direct: 0, hunks: 0, patch: 0 };
  const hub = { ask: async (root) => { calls.status++; return { ok: true, status: 200, data: { repo: root, rootMatch: true, isRepo: true } } } };
  const ctx = load(['core/constants-api.js', 'ui/file-editor-diff.js'], {
    expose: ['EdDirtyDiff'],
    globals: {
      TIMERS: { cancel() {} },
      FileEditor: class {},
      GIT_STATUS_API: '/api/git/status',
      ED_DD_AXIS: 'index', ED_DD_KIND_TEXT: 'text',
      ED_DD_ADD: 'add', ED_DD_MOD: 'mod', ED_DD_DEL: 'del', ED_DD_COLOR_VAR: {},
      ED_DD_STAGE_FAIL: 'f', ED_DD_STAGE_STALE: 's', ED_DD_SAVE_FAIL: 'v', ENC_DD_STAGE_UTF16: 'u', GIT_WRITE_ERR: {}, GIT_PATCH_STAGE: 'stage',
      pathUnder: (r, p) => p.startsWith(r + '/'),
      pathRel: (r, p) => p.slice(r.length + 1),
      gitRepoPrefix: () => '',
      editorGitBackoffMs: () => 1000,
      gitHunkCoordsForChange: () => ({ hunk: 0, from: 1, to: 1, wide: false }),
      gitFetch: async (path) => {
        if (path === '/api/git/status') { calls.direct++; return { ok: true, status: 200, data: {} } }
        if (path === '/api/git/hunks') { calls.hunks++; return { ok: true, status: 200, data: { hunks: [], diffId: 'd' } } }
        calls.diff++;
        return { ok: true, status: 200, data: { path: 'a.txt', original: { kind: 'text', content: 'x\n' } } };
      },
      gitPost: async () => { calls.patch++; return { ok: true, status: 200, data: {} } },
    },
  });
  const docs = new Map();
  const app = {
    edRoots: () => ['/r'],
    edDocAt: () => null,
    gitStatusHub: () => hub,
    // app-editor-pane.js 의 gitSignal 감싸개와 같은 일 — 열린 문서 전부를 refresh 한다.
    gitSignal() { for (const d of docs.values()) d.dd.refresh() },
  };
  const dd = new ctx.EdDirtyDiff(app, '/r/a.txt');
  docs.set('/r/a.txt', { dd });
  return { dd, calls };
}

test('기준을 받을 때 status 는 hub 를 지난다 — 직접 묻지 않는다 (FEU-5)', async () => {
  const { dd, calls } = setup();
  await dd.refresh();
  assert.deepEqual({ status: calls.status, direct: calls.direct, diff: calls.diff }, { status: 1, direct: 0, diff: 1 });
  assert.equal(dd.repo, '/r');
});

test('stage 성공은 gitSignal 한 번으로 기준을 다시 받는다 — refresh 를 겹쳐 부르지 않는다 (FEU-4)', async () => {
  const { dd, calls } = setup();
  await dd.refresh();
  const before = { status: calls.status, diff: calls.diff };
  const res = await dd.stage({ line: 1, count: 1 }, null);
  assert.equal(res.ok, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual({ status: calls.status - before.status, diff: calls.diff - before.diff }, { status: 1, diff: 1 },
    '종전에는 status 2 · diff-content 2');
});
