/**
 * `ui/drop-entries.js` 의 계약 (TERMINAL_FOLDER_DROP_SRS §4.1).
 *
 * 의존이 0 인 순수 함수이므로 브라우저 없이 잰다 — 이 저장소에서 순수 모듈은
 * 그렇게 한다. `FileSystemEntry` 는 인터페이스가 좁아 손으로 세울 수 있다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

// 고전 스크립트라 `import` 로 꺼낼 수 없다 — 이 저장소의 관용구를 따른다.
const { dropEntries, walkDropEntry, walkDrop } = load(['ui/drop-entries.js']);

// ── 가짜 FileSystemEntry ──────────────────────────────────────────────
//
// `readEntries` 가 **한 번에 전부 주지 않는다**는 실제 동작을 흉내 낸다 — 빈
// 배열이 올 때까지 되풀이해야 한다는 계약이 그 위에 서 있다.
const file = (name) => ({
  isFile: true, isDirectory: false, name,
  file: (ok) => ok({ name, size: name.length }),
});
const dir = (name, kids, batch = 2) => ({
  isFile: false, isDirectory: true, name,
  createReader() {
    let i = 0;
    return {
      readEntries(ok) {
        const out = kids.slice(i, i + batch);
        i += out.length;
        ok(out);
      },
    };
  },
});
const drop = (entries) => ({
  dataTransfer: {
    items: entries.map((en) => ({ kind: 'file', webkitGetAsEntry: () => en })),
  },
});

const MAX = 10000;

test('TC-TFD-1: 파일만 있는 드롭은 relPath 가 이름 하나다', async () => {
  const r = await walkDrop(drop([file('a.txt'), file('b.txt')]), MAX);
  assert.equal(r.over, false);
  assert.deepEqual(plain(r.items.map((x) => x.relPath)), ['a.txt', 'b.txt']);
});

test('TC-TFD-2: 폴더는 재귀로 펴지고 relPath 가 뿌리부터다', async () => {
  const tree = dir('top', [
    file('one.txt'),
    dir('sub', [file('deep.txt'), dir('deeper', [file('x.md')])]),
    file('two.txt'),
  ]);
  const r = await walkDrop(drop([tree]), MAX);
  assert.equal(r.over, false);
  assert.deepEqual(plain(r.items.map((x) => x.relPath)), [
    'top/one.txt',
    'top/sub/deep.txt',
    'top/sub/deeper/x.md',
    'top/two.txt',
  ]);
});

test('TC-TFD-3: 빈 폴더는 항목을 만들지 않는다', async () => {
  const r = await walkDrop(drop([dir('empty', [])]), MAX);
  assert.deepEqual(plain(r.items), []);
  assert.equal(r.over, false);
});

test('TC-TFD-4: 상한을 넘으면 걷기를 멈추고 부분 결과를 쓰지 않는다 (FR-TFD-14)', async () => {
  const many = dir('big', Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`)));
  const r = await walkDrop(drop([many]), 5);
  assert.equal(r.over, true);
  assert.deepEqual(plain(r.items), [], '절반만 올라간 폴더는 되돌릴 길이 없다');
});

test('TC-TFD-5: items 가 없으면 null — 호출자가 files 로 내려간다', async () => {
  assert.equal(dropEntries({ dataTransfer: { items: [] } }), null);
  assert.equal(dropEntries({ dataTransfer: {} }), null);
  assert.equal(dropEntries({}), null);
  assert.equal(await walkDrop({ dataTransfer: {} }, MAX), null);
});

test('kind 가 file 이 아닌 항목(문자열 드래그)은 건너뛴다', () => {
  const e = { dataTransfer: { items: [{ kind: 'string', webkitGetAsEntry: () => file('x') }] } };
  assert.equal(dropEntries(e), null);
});

test('webkitGetAsEntry 가 없는 브라우저는 null 이다', () => {
  assert.equal(dropEntries({ dataTransfer: { items: [{ kind: 'file' }] } }), null);
});

test('읽지 못한 파일은 건너뛰고 나머지는 올린다 (FR-ETR-26)', async () => {
  const bad = { isFile: true, isDirectory: false, name: 'bad', file: (_ok, err) => err() };
  const r = await walkDrop(drop([bad, file('good.txt')]), MAX);
  assert.deepEqual(plain(r.items.map((x) => x.relPath)), ['good.txt']);
});

test('readEntries 가 나누어 주어도 전부 걷는다', async () => {
  const kids = Array.from({ length: 7 }, (_, i) => file(`k${i}.txt`));
  const out = [];
  const ok = await walkDropEntry(dir('d', kids, 2), '', out, MAX);
  assert.equal(ok, true);
  assert.equal(out.length, 7, '한 번에 전부 주지 않는 readEntries 를 되풀이해 읽는다');
});
