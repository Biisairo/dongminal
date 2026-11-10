import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * ISSUE_TREE_OPS_SRS TC-ITC-5 (FR-ITC-12~16): 트리 보기 계산.
 * 보기는 {s, x, y} 다 — s 는 화면 px / viewBox 단위, (x, y) 는 보는 범위의 왼쪽 위(viewBox 좌표).
 */
const ctx = load(['ui/run-tree-cam.js'], {
  expose: ['runCamFit', 'runCamZoomAt', 'runCamPan', 'runCamClamp', 'runCamCenterOn', 'runCamRange', 'RUN_CAM_FIT_MAX', 'RUN_CAM_MIN', 'RUN_CAM_MAX'],
});
const { runCamFit, runCamZoomAt, runCamPan, runCamClamp, runCamCenterOn, runCamRange, RUN_CAM_FIT_MAX, RUN_CAM_MIN, RUN_CAM_MAX } = ctx;

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const tree = { w: 1000, h: 400 };
const area = { w: 500, h: 300 };

test('맞춤: 큰 트리는 전체가 들어오게 줄이고 가운데에 놓는다', () => {
  const c = runCamFit(tree, area);
  close(c.s, 0.5, '폭이 정하는 배율');
  // 보는 범위의 가운데 = 트리 가운데.
  close(c.x + area.w / c.s / 2, tree.w / 2, '가로 가운데');
  close(c.y + area.h / c.s / 2, tree.h / 2, '세로 가운데');
});

test('맞춤: 높이가 정하면 높이로 줄인다', () => {
  close(runCamFit({ w: 100, h: 900 }, area).s, 300 / 900, '높이가 정하는 배율');
});

test('맞춤: 작은 트리는 상한까지만 키운다', () => {
  const c = runCamFit({ w: 100, h: 50 }, area);
  close(c.s, RUN_CAM_FIT_MAX, '상한');
  assert.equal(RUN_CAM_FIT_MAX, 1.5);
});

test('맞춤: 영역이나 트리가 비면 null 이다', () => {
  assert.equal(runCamFit({ w: 0, h: 0 }, area), null);
  assert.equal(runCamFit(tree, { w: 0, h: 300 }), null);
});

test('배율 범위: 20%~300%, 맞춤이 더 작으면 하한은 맞춤이다', () => {
  assert.equal(RUN_CAM_MIN, 0.2);
  assert.equal(RUN_CAM_MAX, 3);
  assert.deepEqual({ ...runCamRange(0.5) }, { min: 0.2, max: 3 });
  assert.deepEqual({ ...runCamRange(0.05) }, { min: 0.05, max: 3 });
});

test('줌: 커서 아래 점이 그 자리에 남는다', () => {
  const c = { s: 1, x: 100, y: 50 };
  const px = 120, py = 80; // 영역 안 화면 좌표
  const before = { x: c.x + px / c.s, y: c.y + py / c.s };
  const z = runCamZoomAt(c, 2, px, py, { min: 0.2, max: 3 });
  close(z.s, 2, '배율');
  close(z.x + px / z.s, before.x, '가로 점 유지');
  close(z.y + py / z.s, before.y, '세로 점 유지');
});

test('줌: 범위 밖으로 나가지 않는다', () => {
  const r = { min: 0.2, max: 3 };
  close(runCamZoomAt({ s: 2.5, x: 0, y: 0 }, 10, 0, 0, r).s, 3, '상한');
  close(runCamZoomAt({ s: 0.3, x: 0, y: 0 }, 0.01, 0, 0, r).s, 0.2, '하한');
});

test('패닝: 화면에서 끈 만큼 반대로 보는 범위가 움직인다', () => {
  const p = runCamPan({ s: 2, x: 100, y: 100 }, 40, -20);
  close(p.x, 80, '가로');
  close(p.y, 110, '세로');
  close(p.s, 2, '배율 그대로');
});

test('가운데는 트리 경계 밖으로 나가지 않는다', () => {
  const c = runCamClamp({ s: 1, x: 5000, y: -5000 }, tree, area);
  const cx = c.x + area.w / 2, cy = c.y + area.h / 2;
  close(cx, tree.w, '오른쪽 끝');
  close(cy, 0, '위쪽 끝');
  const ok = { s: 1, x: 100, y: 10 };
  assert.deepEqual({ ...runCamClamp(ok, tree, area) }, ok);
});

test('미니맵: 누른 점이 보는 범위의 가운데가 된다', () => {
  const c = runCamCenterOn({ s: 2, x: 0, y: 0 }, 600, 200, area);
  close(c.x + area.w / c.s / 2, 600, '가로');
  close(c.y + area.h / c.s / 2, 200, '세로');
  close(c.s, 2, '배율 그대로');
});
