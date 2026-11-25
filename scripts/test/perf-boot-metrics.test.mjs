import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootNetCollector, longTasksFromTrace } from '../perf/boot-metrics.mjs';

/**
 * 성능 이슈 3.4.1: scenario.mjs boot 단계의 부팅 지표 집계 (NFR-PRF-11·12, M3_DESIGN §3.4 "목표를 재는 법").
 */

const send = (c, id, type, url = `http://h/${id}`) => c.request({ requestId: id, type, request: { url, method: 'GET' } });

test('요청을 CDP 자원 종류별로 센다', () => {
  const c = bootNetCollector();
  send(c, '1', 'Document');
  send(c, '2', 'Script');
  send(c, '3', 'Script');
  send(c, '4', 'Stylesheet');
  send(c, '5', undefined);
  const s = c.summary();
  assert.equal(s.requests, 5);
  assert.deepEqual(s.byType, { Document: 1, Script: 2, Stylesheet: 1, Other: 1 });
});

test('부팅 JS 바이트는 스크립트 응답의 풀린 크기(dataLength) 합이다', () => {
  const c = bootNetCollector();
  send(c, 's1', 'Script');
  send(c, 's2', 'Script');
  send(c, 'css', 'Stylesheet');
  c.data({ requestId: 's1', dataLength: 1000, encodedDataLength: 0 });
  c.data({ requestId: 's1', dataLength: 500, encodedDataLength: 0 });
  c.data({ requestId: 's2', dataLength: 200, encodedDataLength: 0 });
  c.data({ requestId: 'css', dataLength: 9999, encodedDataLength: 0 });
  c.finished({ requestId: 's1', encodedDataLength: 400 });
  c.finished({ requestId: 's2', encodedDataLength: 150 });
  c.finished({ requestId: 'css', encodedDataLength: 3000 });
  const s = c.summary();
  assert.equal(s.jsBytes, 1700);
  assert.equal(s.jsEncodedBytes, 550);
  assert.equal(s.jsFiles, 2);
});

test('응답에서야 종류가 정해진 요청도 스크립트로 친다', () => {
  const c = bootNetCollector();
  send(c, 'x', undefined);
  c.response({ requestId: 'x', type: 'Script' });
  c.data({ requestId: 'x', dataLength: 70 });
  const s = c.summary();
  assert.equal(s.jsBytes, 70);
  assert.deepEqual(s.byType, { Script: 1 });
});

test('요청 없이 온 데이터·끝 이벤트는 무시한다', () => {
  const c = bootNetCollector();
  c.data({ requestId: 'ghost', dataLength: 10 });
  c.finished({ requestId: 'ghost', encodedDataLength: 10 });
  c.response({ requestId: 'ghost', type: 'Script' });
  assert.deepEqual(c.summary(), { requests: 0, byType: {}, jsFiles: 0, jsBytes: 0, jsEncodedBytes: 0 });
});

test('같은 requestId 의 리다이렉트는 요청 수에 더하되 종류는 하나로 남는다', () => {
  const c = bootNetCollector();
  send(c, 'r', 'Script');
  send(c, 'r', 'Script');
  const s = c.summary();
  assert.equal(s.requests, 2);
  assert.deepEqual(s.byType, { Script: 2 });
  assert.equal(s.jsFiles, 1);
});

const meta = (pid, tid, name) => ({ ph: 'M', name: 'thread_name', pid, tid, args: { name } });
const task = (pid, tid, durMs, name = 'RunTask') => ({ ph: 'X', name, pid, tid, ts: 0, dur: durMs * 1000 });

test('렌더러 메인 스레드의 16 ms 초과 RunTask 만 센다', () => {
  const ev = [
    meta(1, 10, 'CrRendererMain'),
    meta(1, 11, 'Compositor'),
    task(1, 10, 28),
    task(1, 10, 17.5),
    task(1, 10, 16),
    task(1, 10, 3),
    task(1, 11, 40),
    task(1, 10, 90, 'FunctionCall'),
  ];
  assert.deepEqual(longTasksFromTrace(ev), { count: 2, maxMs: 28, totalMs: 45.5, tasksMs: [28, 17.5] });
});

test('렌더러가 여럿이면 모두 본다', () => {
  const ev = [meta(1, 10, 'CrRendererMain'), meta(2, 20, 'CrRendererMain'), task(1, 10, 20), task(2, 20, 30)];
  assert.equal(longTasksFromTrace(ev).count, 2);
});

test('긴 작업이 없으면 0 이다', () => {
  assert.deepEqual(longTasksFromTrace([meta(1, 10, 'CrRendererMain'), task(1, 10, 5)]), { count: 0, maxMs: 0, totalMs: 0, tasksMs: [] });
  assert.deepEqual(longTasksFromTrace([]), { count: 0, maxMs: 0, totalMs: 0, tasksMs: [] });
});

test('기준(ms)을 바꿀 수 있다', () => {
  const ev = [meta(1, 10, 'CrRendererMain'), task(1, 10, 20), task(1, 10, 60)];
  assert.equal(longTasksFromTrace(ev, 50).count, 1);
});
