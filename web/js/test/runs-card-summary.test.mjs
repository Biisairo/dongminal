import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * ORCHESTRATION_V2_SRS FR-RVZ-3 (개정 2026-11-12) — Run 카드의 멤버 수와 경과.
 *
 *   멤버 수  활성/전체. 활성은 끝남·잃음이 아닌 멤버이고, 헤드리스 수도 활성만 센다.
 *   경과     마지막 활동(생성·보고·맥락 관측·메시지·조정자 맥락 관측 중 가장 늦은 것).
 */
const ctx = load(['ui/runs-panel.js', 'ui/run-tree.js'], {
  globals: { t: (k) => k, panesOf: () => [] },
  expose: ['runMemberCounts', 'runLastActivity'],
});

test('활성은 끝남·잃음을 빼고, 헤드리스도 활성만 센다', () => {
  const c = ctx.runMemberCounts([
    { state: 'working' }, { state: 'waiting-children' }, { state: 'done' }, { state: 'failed' },
    { state: 'released' }, { state: 'lost' }, { state: 'lost', headless: true },
    { state: 'waiting', headless: true },
  ]);
  assert.equal(JSON.stringify(c), JSON.stringify({ active: 3, total: 8, headless: 1 }));
});

test('멤버가 없으면 0/0', () => {
  assert.equal(JSON.stringify(ctx.runMemberCounts(undefined)), JSON.stringify({ active: 0, total: 0, headless: 0 }));
});

test('마지막 활동은 알려진 시각 가운데 가장 늦은 것이다', () => {
  const rv = {
    createdAt: 100,
    coordinator: { contextAt: 150 },
    messages: [{ at: 120 }, { at: 170 }],
    members: [{ createdAt: 110, reportedAt: 130 }, { createdAt: 140, contextAt: 160 }],
  };
  assert.equal(ctx.runLastActivity(rv), 170);
  rv.members[1].contextAt = 200;
  assert.equal(ctx.runLastActivity(rv), 200);
  rv.coordinator.contextAt = 250;
  assert.equal(ctx.runLastActivity(rv), 250);
});

test('활동 기록이 없으면 생성 시각이다', () => {
  assert.equal(ctx.runLastActivity({ createdAt: 100 }), 100);
  assert.equal(ctx.runLastActivity({ createdAt: 100, members: [{ createdAt: 90 }], messages: [] }), 100);
});
