import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * UX_BATCH12_SRS TC-EXM-6 (FR-EXM-6·7) — 탐색기 클립보드가 경로 목록을 담고,
 * 붙여넣기·복제가 그 목록을 다룬다.
 */
const COPY = '/api/fs/copy';
const RENAME = '/api/fs/rename';

function setup(fail = () => '') {
  const written = [];
  const ctx = load(['core/path.js', 'ui/repaint.js', 'ui/file-tree-paint.js', 'ui/file-tree-edit.js', 'ui/file-tree-xfer.js', 'core/app-editor-file.js'], {
    globals: {
      TermClipboard: { write: async (s) => { written.push(s); return true } },
      Toast: { show: () => {} },
      EDITOR_PATH_COPIED: 'copied',
      App: class {},
      FileTree: class {},
      FS_COPY_API: COPY,
      FS_RENAME_API: RENAME,
      pathSep: () => '/',
    },
  });
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  const app = Object.create(ctx.App.prototype);
  app.edFs = async (url, body) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    calls.push({ url, body });
    await new Promise((r) => setImmediate(r));
    inflight--;
    const src = body.src || body.from;
    const why = fail(src);
    if (why) return { ok: false, code: 'gone', msg: why };
    const made = url === COPY ? body.dstDir + '/' + src.split('/').pop() + ' copy' : body.to;
    return { ok: true, code: '', msg: '', data: { ok: true, path: made } };
  };
  app.edRefreshTreesFor = () => {};
  const t = Object.create(ctx.FileTree.prototype);
  Object.assign(t, {
    root: '/r', app, _open: new Set(), _sel: '', _selSet: new Set(), _err: null,
    _after: async () => {}, _retargetOrFail: () => {}, _paintAll: () => {},
  });
  return { app, t, calls, written, max: () => maxInflight };
}

test('TC-EXM-6a: edClipSet 은 문자열 하나도 목록으로 받는다', () => {
  const { app } = setup();
  app.edClipSet('/r', '/r/a', true);
  assert.deepEqual({ ...app.edClipGet(), paths: [...app.edClipGet().paths] }, { root: '/r', paths: ['/r/a'], move: true });
});

test('TC-EXM-6b: edClipSet 은 목록의 순서를 지키고 빈 값을 거른다', () => {
  const { app } = setup();
  app.edClipSet('/r', ['/r/b', '', '/r/a']);
  assert.deepEqual([...app.edClipGet().paths], ['/r/b', '/r/a']);
  assert.equal(app.edClipGet().move, false);
});

test('TC-EXM-6c: 빈 목록이나 루트 없음이면 클립보드를 비운다', () => {
  const { app } = setup();
  app.edClipSet('/r', ['/r/a']);
  app.edClipSet('/r', []);
  assert.equal(app.edClipGet(), null);
  app.edClipSet('/r', '/r/a');
  app.edClipSet(null, null);
  assert.equal(app.edClipGet(), null);
  app.edClipSet('', ['/r/a']);
  assert.equal(app.edClipGet(), null);
});

test('TC-EXM-6d: 두 경로 복사는 차례대로 붙고 만든 둘이 선택된다', async () => {
  const { app, t, calls, max } = setup();
  app.edClipSet('/r', ['/r/a.txt', '/r/b.txt']);
  await t.doPasteInto('/r/dst');
  assert.deepEqual(calls.map((c) => [c.url, c.body.src]), [[COPY, '/r/a.txt'], [COPY, '/r/b.txt']]);
  assert.equal(max(), 1);
  assert.deepEqual([...t._selSet].sort(), ['/r/dst/a.txt copy', '/r/dst/b.txt copy']);
  assert.ok(app.edClipGet(), '복사는 클립보드를 남긴다');
});

test('TC-EXM-6e: 잘라내기 중 하나가 실패하면 클립보드에 실패한 것만 남고 사유가 붙는다', async () => {
  const { app, t, calls } = setup((src) => (src === '/r/b.txt' ? '사라졌다' : ''));
  app.edClipSet('/r', ['/r/a.txt', '/r/b.txt'], true);
  await t.doPasteInto('/r/dst');
  assert.deepEqual(calls.map((c) => [c.url, c.body.from, c.body.to]), [
    [RENAME, '/r/a.txt', '/r/dst/a.txt'], [RENAME, '/r/b.txt', '/r/dst/b.txt']]);
  const c = app.edClipGet();
  assert.deepEqual({ ...c, paths: [...c.paths] }, { root: '/r', paths: ['/r/b.txt'], move: true });
  assert.equal(t._err && t._err.msg, '사라졌다');
  assert.deepEqual([...t._selSet], ['/r/dst/a.txt']);
});

test('TC-EXM-6f: 잘라내기가 모두 성공하면 클립보드가 빈다', async () => {
  const { app, t } = setup();
  app.edClipSet('/r', ['/r/a.txt', '/r/b.txt'], true);
  await t.doPasteInto('/r/dst');
  assert.equal(app.edClipGet(), null);
  assert.deepEqual([...t._selSet].sort(), ['/r/dst/a.txt', '/r/dst/b.txt']);
});

test('TC-EXM-6g: 복제는 클립보드의 목록과 잘라내기 구분을 되돌린다', async () => {
  const { app, t } = setup();
  app.edClipSet('/r', ['/r/x', '/r/y'], true);
  await t.doDuplicate('/r/src/a.txt');
  const c = app.edClipGet();
  assert.deepEqual({ ...c, paths: [...c.paths] }, { root: '/r', paths: ['/r/x', '/r/y'], move: true });
});

test('TC-EXM-2: 여러 항목의 경로 복사는 화면 순서대로 줄바꿈으로 잇는다', async () => {
  const { t, written } = setup();
  t._items = () => ['/r/sub', '/r/sub/x', '/r/a', '/r/b'].map((path) => ({ t: 'row', path }));
  t._selOnly('/r/b'); t._selToggle('/r/sub/x'); t._selToggle('/r/a');
  const ps = t._selOrdered('/r/a');
  assert.deepEqual([...ps], ['/r/sub/x', '/r/a', '/r/b']);
  await t.copyPath(ps, false);
  await t.copyPath(ps, true);
  assert.deepEqual(written, ['/r/sub/x\n/r/a\n/r/b', 'sub/x\na\nb']);
});
