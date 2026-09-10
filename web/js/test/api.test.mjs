import assert from 'node:assert/strict';
import test from 'node:test';

import { load } from './harness.mjs';

/**
 * `core/api.js` 의 전송 계약 (CLIENT_API_SRS §4.1 · TC-CAPI-1~15).
 *
 * **브라우저를 띄우지 않는다.** 이 겹은 `fetch` 하나에만 기대고 그것을 주입받으므로
 * (FR-CAPI-8) 순수 로직으로 잴 수 있다. 이 자리가 없으면 "POST 에 Content-Type 이
 * 실리는가" 같은 것을 e2e 로 재게 되고, 그것이 이 저장소가 이미 겪은 낭비다.
 */

/** 응답 하나를 흉내낸다. 본문은 **한 번만** 읽을 수 있어야 한다 (FR-CAPI-4). */
function reply(status, body, opts = {}) {
  let read = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      assert.equal(read, false, '본문을 두 번 읽었다');
      read = true;
      return body;
    },
    ...opts,
  };
}

/** 호출을 기록하는 가짜 `fetch`. */
function spy(res) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init: init || {} });
    if (res instanceof Error) throw res;
    return typeof res === 'function' ? res(url, init) : res;
  };
  fn.calls = calls;
  return fn;
}

const api = () => load(['core/api.js'], { expose: [] });

// ── 봉투 ───────────────────────────────────────────────────────────────────

test('TC-CAPI-1: 200 + JSON 이면 data 와 text 가 함께 선다', async () => {
  const c = api();
  const r = await c.apiGet('/api/state', { fetch: spy(reply(200, '{"a":1}')) });
  // 봉투를 통째로 견주지 않는다 — vm 안에서 만들어진 객체라 프로토타입이 다르고,
  // `deepEqual` 은 그것을 불일치로 읽는다. 검사 대상은 값이다.
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.data.a, 1);
  assert.equal(r.text, '{"a":1}');
});

test('TC-CAPI-2: 204 는 본문이 없어도 성공이다', async () => {
  const c = api();
  const r = await c.apiPut('/api/sandbox/config', { x: 1 }, { fetch: spy(reply(204, '')) });
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
  assert.equal(r.text, '');
});

test('TC-CAPI-3: 400 + 단문 본문이면 사유가 text 에 남는다', async () => {
  const c = api();
  const r = await c.apiPost('/api/access', {}, { fetch: spy(reply(400, '허용 목록이 깨졌습니다\n')) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.data, null);
  assert.match(r.text, /허용 목록이 깨졌습니다/);
});

test('TC-CAPI-4: 실패해도 본문을 읽는다 — 사유를 버리지 않는다', async () => {
  const c = api();
  const r = await c.apiGet('/api/git/status', { fetch: spy(reply(409, '{"error":"stale","message":"낡았다"}')) });
  assert.equal(r.ok, false);
  assert.equal(r.data.message, '낡았다');
});

test('TC-CAPI-5: 망 실패는 던지지 않고 status 0 으로 돌아온다', async () => {
  const c = api();
  const r = await c.apiGet('/api/state', { fetch: spy(new TypeError('Failed to fetch')) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.data, null);
  assert.equal(r.text, '');
});

test('TC-CAPI-6: 깨진 JSON 은 data 만 비고 원문은 남는다', async () => {
  const c = api();
  const r = await c.apiGet('/api/state', { fetch: spy(reply(200, '{not json')) });
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
  assert.equal(r.text, '{not json');
});

// ── 게이트 계약 (REQUEST_GATE_SRS FR-RQG-5) ─────────────────────────────────

test('TC-CAPI-7: POST 는 본문이 없어도 JSON 을 밝힌다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  await c.apiPost('/api/tools/attention/clear-all', null, { fetch: f });
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(f.calls[0].init.body, undefined);
});

test('TC-CAPI-8: PUT·PATCH·DELETE 도 같다', async () => {
  for (const [call, method] of [['apiPut', 'PUT'], ['apiDel', 'DELETE']]) {
    const c = api();
    const f = spy(reply(200, '{}'));
    if (call === 'apiDel') await c.apiDel('/api/tools/x', { fetch: f });
    else await c[call]('/api/workspace', { a: 1 }, { fetch: f });
    assert.equal(f.calls[0].init.method, method);
    assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  }
  const c = api();
  const f = spy(reply(200, '{}'));
  await c.apiSend('PATCH', '/api/x', { a: 1 }, { fetch: f });
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
});

test('TC-CAPI-9: GET 에는 Content-Type 을 싣지 않는다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  await c.apiGet('/api/state', { fetch: f });
  const h = f.calls[0].init.headers || {};
  assert.equal(h['Content-Type'], undefined);
});

test('TC-CAPI-10: FormData 면 Content-Type 을 세우지 않는다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  const fd = new FormData();
  fd.append('file', 'x');
  await c.apiPost('/api/upload', fd, { fetch: f });
  const h = f.calls[0].init.headers || {};
  assert.equal(h['Content-Type'], undefined, '브라우저가 boundary 를 붙여야 한다');
  assert.equal(f.calls[0].init.body, fd);
});

// ── URL·시한·주입 ──────────────────────────────────────────────────────────

test('TC-CAPI-11: query 는 URLSearchParams 로 조립된다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  await c.apiGet('/api/cwd', { query: { tool: 'a/b c&d' }, fetch: f });
  assert.equal(f.calls[0].url, '/api/cwd?tool=a%2Fb+c%26d');
});

test('TC-CAPI-12: timeout 이 있으면 signal 이 생기고 없으면 없다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  await c.apiGet('/api/state', { fetch: f });
  assert.equal(f.calls[0].init.signal, undefined);

  const f2 = spy(reply(200, '{}'));
  await c.apiGet('/api/state', { timeout: 5000, fetch: f2 });
  assert.ok(f2.calls[0].init.signal, 'timeout 이 signal 을 만들어야 한다');
});

test('TC-CAPI-13: 호출자가 준 signal 이 timeout 을 이긴다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  const mine = AbortSignal.timeout(60_000);
  await c.apiGet('/api/state', { timeout: 5, signal: mine, fetch: f });
  assert.equal(f.calls[0].init.signal, mine);
});

test('TC-CAPI-14: 주입한 fetch 가 전역 대신 불린다', async () => {
  const c = api();
  const f = spy(reply(200, '{}'));
  await c.apiGet('/api/state', { fetch: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/state');
});

test('TC-CAPI-15: parse:false 면 파싱을 시도하지 않는다', async () => {
  const c = api();
  const r = await c.apiGet('/api/file/raw', { parse: false, fetch: spy(reply(200, '{"a":1}')) });
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
  assert.equal(r.text, '{"a":1}');
});

test('TC-CAPI-16: 응답 헤더를 읽을 수 있다 — ETag 가 그 이유다', async () => {
  const c = api();
  const headers = new Headers({ ETag: '"7"' });
  const r = await c.apiGet('/api/workspace', { fetch: spy(reply(200, '{}', { headers })) });
  assert.equal(r.headers.get('ETag'), '"7"');
});

test('TC-CAPI-17: 망 실패면 headers 는 null 이다', async () => {
  const c = api();
  const r = await c.apiGet('/api/workspace', { fetch: spy(new TypeError('nope')) });
  assert.equal(r.headers, null);
});

test('TC-CAPI-18: 응답 없이 resolve 하는 fetch 도 전송 실패다', async () => {
  // 진짜 `fetch` 는 이러지 않지만 구현을 주입받는 겹은 그 입력에 대해 전부여야
  // 한다 — 폴링 잡의 `ctx.fetch` 와 검사 스텁이 이 자리로 들어온다.
  const c = api();
  const r = await c.apiGet('/api/git/status', { fetch: spy(null) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.data, null);
  assert.equal(r.headers, null);
});
