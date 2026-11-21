import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, TOOL, load, plain } from './harness.mjs';

/**
 * REFACTOR3_FE_REST2_SRS FR-FR2-1 · TC-FR2-1 (FC-06): `_pickSandbox` 에서 뽑은 순수 판정 셋.
 * 규칙은 옛 `_pickSandbox` 안의 식 그대로다 (SERVER_DRIVEN_ACTIONS_SRS K-i · UX_BATCH6_SRS FR-SBM-2 · FR-SPK-6).
 */
const fns = () => load([...BASE, ...TOOL], {
  expose: ['sbxWorkPicks', 'sbxDefaultWork', 'sbxPickResult'],
  globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k },
});

const MOUNT = { work: 'mount', copies: false };
const COPY = { work: 'copy', copies: true };
const NONE = { work: 'none', copies: false };

test('TC-FR2-1: sbxWorkPicks 는 방식을 서버 순서로 합치고 같은 방식은 첫 것을 남긴다', () => {
  const { sbxWorkPicks } = fns();
  const copy2 = { work: 'copy', copies: false };
  const list = [{ workPicks: [MOUNT, COPY] }, { workPicks: [copy2, NONE] }, { workPicks: null }, {}];
  assert.deepEqual(plain(sbxWorkPicks(list)), [MOUNT, COPY, NONE]);
  assert.equal(sbxWorkPicks(list)[1], list[0].workPicks[1]);
  assert.deepEqual(plain(sbxWorkPicks([])), []);
});

test('TC-FR2-1: sbxDefaultWork — 첫 프로파일의 방식 → copies → 첫 것 → null', () => {
  const { sbxDefaultWork } = fns();
  assert.equal(sbxDefaultWork([{ work: 'copy' }], [MOUNT, COPY]), COPY);
  assert.equal(sbxDefaultWork([{ work: 'other' }], [MOUNT, COPY]), COPY);
  assert.equal(sbxDefaultWork([{ work: 'other' }], [MOUNT, NONE]), MOUNT);
  assert.equal(sbxDefaultWork([], [MOUNT]), MOUNT);
  assert.equal(sbxDefaultWork([{ work: 'mount' }], []), null);
});

test('TC-FR2-1: sbxPickResult — 고른 방식 → 프로파일 방식 → 첫 것', () => {
  const { sbxPickResult } = fns();
  const p = { name: 'dev', work: 'copy', workPicks: [MOUNT, COPY] };
  assert.deepEqual(plain(sbxPickResult(p, MOUNT, '/w')), { profile: 'dev', work: 'mount', copies: false, workdir: '/w' });
  assert.deepEqual(plain(sbxPickResult(p, NONE, '/w')), { profile: 'dev', work: 'copy', copies: true, workdir: '/w' });
  assert.deepEqual(plain(sbxPickResult(p, null, '')), { profile: 'dev', work: 'copy', copies: true, workdir: '' });
  const q = { name: 'q', work: 'gone', workPicks: [MOUNT] };
  assert.deepEqual(plain(sbxPickResult(q, null, '/x')), { profile: 'q', work: 'mount', copies: false, workdir: '/x' });
});

test('TC-FR2-1: sbxPickResult — 고를 방식이 없으면 폴더를 버리고 프로파일의 방식이다', () => {
  const { sbxPickResult } = fns();
  assert.deepEqual(plain(sbxPickResult({ name: 's', work: 'none', workPicks: [] }, MOUNT, '/w')),
    { profile: 's', work: 'none', copies: false, workdir: '' });
  assert.deepEqual(plain(sbxPickResult({ name: 's' }, null, '/w')), { profile: 's', work: '', copies: false, workdir: '' });
});
