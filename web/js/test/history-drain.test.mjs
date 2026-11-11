import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/git/history-load.js` — 로드 뒤의 낡음 판정은 관측 하나에 **한 번**이다
 * (GIT_VIEW_REFRESH_SRS FR-GVR-8b).
 *
 * `staleFor` 는 "목록과 관측의 signature 가 다르다" 만 안다 — 어느 쪽이 새로운지는
 * 모른다. 관측이 멈춰(가려진 탭은 status 를 폴링하지 않는다) 옛 값에 머무는 동안
 * 저장소가 움직이면, 새로 받은 목록은 언제나 그 옛 값과 다르다. 종전에는 `_drain` 이
 * 그것을 볼 때마다 다시 받아 `/api/git/log` 를 지연 없이 되풀이했다
 * (2026-11-11 실측: 다른 PC 의 가려진 History 가 초당 약 24회, 두 시간 넘게).
 */

const CAP = 12;

function history(obsSig) {
  const calls = { n: 0 };
  const ctx = load(['git/history-load.js'], {
    globals: {
      GitHistory: function GitHistory() {},
      GIT_API: { log: '/api/git/log' },
      GIT_HIST_LOAD_FAIL: 'fail',
      GitConfirm: { policy: async () => null },
      gitLogLimit: () => undefined,
    },
  });
  const h = Object.create(ctx.GitHistory.prototype);
  Object.assign(h, {
    _repo: 'r', _el: {}, _commits: [], _filters: {}, _order: '', _grep: '', _reflog: false, _ref: '',
    _paintBar() {}, _paintFoot() {}, paint() {}, _rebuild() {},
  });
  h.panel = { repo: 'r', _lastSig: obsSig, token: () => 1, isStale: () => false };
  h.repoSig = 'NEW';
  h._get = async (_path, sent) => {
    calls.n++;
    if (calls.n > CAP) return null;   // 고리를 끊는다 — 시험이 멈추지 않게
    return { requested: { ...sent }, commits: [], signature: h.repoSig };
  };
  return { h, calls };
}

test('관측이 옛 값에 머물면 로드 뒤 다시 받기는 한 번뿐이다 (FR-GVR-8b)', async () => {
  const { h, calls } = history('OLD');
  await h._load(false);
  assert.equal(calls.n, 2, `관측이 멈춘 동안 log 를 ${calls.n}번 불렀다 — 한 번 더 받고 멈춰야 한다`);
});

test('받는 도중 관측이 지나갔으면 한 번 더 받아 따라간다 (FR-GVR-8a 그대로)', async () => {
  const { h, calls } = history('NEW');     // 관측은 이미 변경 뒤의 값이다
  const get = h._get;
  // 첫 log 만 변경 전에 돌았다 — 그 목록은 OLD 시각의 것이다.
  h._get = async (path, sent) => { const d = await get(path, sent); if (calls.n === 1) d.signature = 'OLD'; return d };
  await h._load(false);
  assert.equal(calls.n, 2);
  assert.equal(h._loadedSig, 'NEW', '목록이 관측을 따라잡아야 한다');
});

test('관측이 새 값으로 바뀌면 그 값에 대해 다시 한 번 판정한다 (FR-GVR-8b)', async () => {
  const { h, calls } = history('OLD');
  await h._load(false);
  h.panel._lastSig = 'OLDER';              // 새 관측 — 여전히 목록과 다르다
  h.repoSig = 'NEW2';
  await h._load(false);
  assert.equal(calls.n, 4, '관측 하나마다 다시 받기 한 번');
});
