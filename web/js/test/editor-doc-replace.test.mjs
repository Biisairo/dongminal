import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load } from './harness.mjs';

/**
 * EDITOR_LIVE_RELOAD_SRS 묶음 F — 디스크 내용을 문서에 넣는 일(`edDocRefresh`·`_edDocReplace`).
 *
 * 문서 레코드는 `edDoc` 이 만드는 모양만 흉내낸다. 읽기(`_edDocRead`)는 응답을 바로 준다.
 */

const CM = await loadCM();
const PATH = '/r/a.md';

function setup() {
  const ctx = load(['ui/cm-buffer.js', 'core/doc-token.js', 'core/app-editor-doc.js'], {
    globals: { CM, App: class {}, FILE_STAMP_HEADER: 'X-File-Stamp' },
    expose: ['EdBuffer'],
  });
  const a = new ctx.App();
  const d = { gen: 0, views: new Set(), dirty: false, buf: null, stamp: '', loading: null };
  a._edDocs = new Map([[PATH, d]]);
  let next = null;
  a._edDocRead = async () => next;
  const res = (text, stamp) => ({ ok: true, text, headers: { get: (k) => (k === 'X-File-Stamp' ? stamp : null) } });
  a._edDocCreate(d, res('old\n', 's1'));
  return { a, d, serve: (text, stamp) => { next = res(text, stamp) } };
}

test('V-ELR-14 (FR-ELR-36): 바깥 내용을 넣는 동안 구독자가 보는 dirty 는 거짓이고 넣은 뒤에도 거짓이다', async () => {
  const { a, d, serve } = setup();
  const seen = [];
  d.buf.onChange(() => seen.push(d.dirty));
  serve('new\n', 's2');
  assert.equal(await a.edDocRefresh(PATH), true);
  assert.deepEqual(seen, [false]);
  assert.equal(d.dirty, false);
  assert.equal(d.buf.value(), 'new\n');
  assert.equal(d.stamp, 's2');
});

test('V-ELR-15 (FR-ELR-37): 반영 도중 예외가 나면 표식은 옛 값이고 다음 refresh 가 표식을 맞춘다', async () => {
  const { a, d, serve } = setup();
  let fail = true;
  d.buf.onChange(() => { if (fail) throw new Error('boom') });
  serve('new\n', 's2');
  const orig = console.error;
  console.error = () => {};
  let first;
  try { first = await a.edDocRefresh(PATH) } finally { console.error = orig }
  assert.equal(first, false);
  assert.equal(d.stamp, 's1', '실패한 회차는 표식을 옮기지 않는다 — 다음 회차가 다시 읽는다');
  assert.equal(d.dirty, false, 'dirty 로 남으면 폴링이 그 문서를 다시 묻지 않는다');

  fail = false;
  assert.equal(await a.edDocRefresh(PATH), true);
  assert.equal(d.stamp, 's2');
  assert.equal(d.dirty, false);
  assert.equal(d.buf.value(), 'new\n');
});
