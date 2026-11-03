import assert from 'node:assert/strict';
import test from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * `ui/cm-scrollbar.js` 의 좌표 함수 — CODEMIRROR_MIGRATION_SRS FR-CMR-71·74 / §11.3.
 *
 * 미니맵의 뷰포트 표시도 같은 `edScrollThumb` 를 쓴다(FR-CMR-61) — 둘이 같은 자리에 서는 근거가 이 함수다.
 */

const ctx = load(['ui/cm-scrollbar.js'], {
  globals: { ED_SCROLL_MIN_THUMB: 20 },
  expose: ['edScrollThumb', 'edScrollFromThumb', 'edRulerY'],
});
const thumb = (g) => plain(ctx.edScrollThumb(g));
const geo = (o) => ({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500, trackHeight: 500, ...o });

test('FR-CMR-74: thumb 의 높이는 보이는 비율이고 위치는 스크롤 비율이다', () => {
  assert.deepEqual(thumb(geo({})), { top: 0, height: 125, visible: true });
  assert.deepEqual(thumb(geo({ scrollTop: 750 })), { top: 187.5, height: 125, visible: true });
  assert.deepEqual(thumb(geo({ scrollTop: 1500 })), { top: 375, height: 125, visible: true });
});

test('FR-CMR-74: 넘치지 않으면 thumb 는 없다 — track 전체 높이로 둔다', () => {
  assert.deepEqual(thumb(geo({ scrollHeight: 500 })), { top: 0, height: 500, visible: false });
  assert.deepEqual(thumb(geo({ scrollHeight: 400 })), { top: 0, height: 500, visible: false });
});

test('FR-CMR-74: 아주 긴 문서도 thumb 는 최소 높이를 지킨다', () => {
  const t = thumb(geo({ scrollHeight: 1e6, scrollTop: (1e6 - 500) / 2 }));
  assert.equal(t.height, 20);
  assert.equal(t.top, 240);
});

test('scrollTop 이 범위를 넘어도 thumb 는 track 안에 선다', () => {
  assert.equal(thumb(geo({ scrollTop: -30 })).top, 0);
  assert.equal(thumb(geo({ scrollTop: 99999 })).top, 375);
});

test('track 이 0 이면 thumb 도 0 이다 (숨은 칸)', () => {
  assert.deepEqual(thumb(geo({ trackHeight: 0, clientHeight: 0 })), { top: 0, height: 0, visible: false });
});

test('thumb 를 끈 자리에서 scrollTop 을 되돌린다 — edScrollThumb 의 역이다', () => {
  const g = geo({});
  for (const st of [0, 300, 1500]) {
    const t = ctx.edScrollThumb({ ...g, scrollTop: st });
    assert.equal(ctx.edScrollFromThumb(t.top, g), st);
  }
  assert.equal(ctx.edScrollFromThumb(-10, g), 0);
  assert.equal(ctx.edScrollFromThumb(9999, g), 1500);
  assert.equal(ctx.edScrollFromThumb(10, geo({ scrollHeight: 500 })), 0, '넘치지 않으면 움직이지 않는다');
});

test('FR-CMR-71: ruler 의 세로 위치는 줄 top / 내용 높이 비율이다', () => {
  assert.equal(ctx.edRulerY(0, 2000, 500), 0);
  assert.equal(ctx.edRulerY(1000, 2000, 500), 250);
  assert.equal(ctx.edRulerY(2000, 2000, 500), 500);
  assert.equal(ctx.edRulerY(5000, 2000, 500), 500, '범위 밖은 끝에 붙는다');
  assert.equal(ctx.edRulerY(10, 0, 500), 0, '내용 높이가 0 이면 위에 둔다');
});
