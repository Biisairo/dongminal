import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * UX_BATCH12_SRS FR-RMM-3: 미니맵의 보기 상자 끌기 계산.
 * 상자 안을 잡으면 잡은 점과 상자의 거리를 지키고, 상자 밖을 잡으면 그 점이 가운데가 된 뒤 따라온다.
 */
const ctx = load(['ui/run-tree-cam.js'], { expose: ['runCamGrab', 'runCamDragTo'] });
const { runCamGrab, runCamDragTo } = ctx;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const area = { w: 500, h: 300 };
const cam = { s: 2, x: 100, y: 50 }; // 보는 범위: x 100~350, y 50~200

test('상자 안을 잡으면 보기는 그대로이고, 끌면 잡은 거리를 지키며 옮긴다', () => {
  const g = runCamGrab(cam, area, { x: 150, y: 80 });
  close(g.cam.x, 100, '잡을 때 x 그대로'); close(g.cam.y, 50, '잡을 때 y 그대로');
  close(g.off.x, 50, '잡은 거리 x'); close(g.off.y, 30, '잡은 거리 y');
  const moved = runCamDragTo(g.cam, g.off, { x: 400, y: 120 });
  close(moved.x, 350, '끈 뒤 x'); close(moved.y, 90, '끈 뒤 y'); close(moved.s, 2, '배율 그대로');
});

test('상자 밖을 잡으면 그 점이 가운데가 되고, 이어서 끌면 가운데로 따라온다', () => {
  const g = runCamGrab(cam, area, { x: 800, y: 300 });
  close(g.cam.x + area.w / g.cam.s / 2, 800, '가운데 x'); close(g.cam.y + area.h / g.cam.s / 2, 300, '가운데 y');
  const moved = runCamDragTo(g.cam, g.off, { x: 820, y: 310 });
  close(moved.x + area.w / moved.s / 2, 820, '끈 뒤 가운데 x'); close(moved.y + area.h / moved.s / 2, 310, '끈 뒤 가운데 y');
});

test('상자의 경계 위를 잡은 것은 안이다', () => {
  const g = runCamGrab(cam, area, { x: 100, y: 200 });
  close(g.cam.x, 100, 'x 그대로'); close(g.off.x, 0, '거리 x 0'); close(g.off.y, 150, '거리 y');
});
