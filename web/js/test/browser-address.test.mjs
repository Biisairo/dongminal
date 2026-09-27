import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * BROWSER_TAB_SRS TC-BRT-53 · FR-BRT-41 — 주소창이 받는 것. URL 이 아니고 경로도 아니면 거절(null).
 * 경로는 **절대 경로만** 받는다 — 주소창에는 기준 폴더가 없다.
 */
const c = load(['ui/browser-view.js'], { globals: { URL } });
const addr = (s) => c.browserAddressURL(s);

test('URL — 허용 넷과 스킴 없는 host:port', () => {
  assert.equal(addr('https://example.com/a'), 'https://example.com/a');
  assert.equal(addr('about:blank'), 'about:blank');
  assert.equal(addr('localhost:3000'), 'http://localhost:3000');
  assert.equal(addr('example.com'), 'http://example.com');
});

test('거절 — javascript·data·chrome·검색어·상대 경로', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'hello world', 'docs/a.md', '~/a.html', '']) {
    assert.equal(addr(s), null, s);
  }
});

test('절대 경로 → file:// (POSIX · Windows)', () => {
  assert.equal(addr('/tmp/a b.html'), 'file:///tmp/a%20b.html');
  assert.equal(addr('C:\\Users\\me\\a.html'), 'file:///C:/Users/me/a.html');
  assert.equal(addr('d:/x/y.html'), 'file:///D:/x/y.html');
});

// TC-BRT-41 의 뿌리: WS 가 열리기 전에 보낸 조작은 모았다가 열리면 보낸다. 끊겨 있으면 버린다.
test('여는 중에 보낸 조작은 모았다가 보낸다', () => {
  const V = load(['ui/browser-view.js'], { globals: { URL, BRV_OUTBOX_MAX: 2 }, expose: ['BrowserView'] }).BrowserView;
  const sent = [];
  const v = { ws: { readyState: 0, send: (s) => sent.push(JSON.parse(s).op) } };
  V.prototype._send.call(v, { op: 'viewport' });
  V.prototype._send.call(v, { op: 'zoom' });
  V.prototype._send.call(v, { op: 'find' });
  assert.deepEqual([...v._outbox].map((m) => m.op), ['viewport', 'zoom'], '상한을 넘은 것은 버린다');
  v.ws.readyState = 1;
  for (const m of v._outbox) V.prototype._send.call(v, m);
  assert.deepEqual(sent, ['viewport', 'zoom']);
  const dead = { ws: null };
  V.prototype._send.call(dead, { op: 'nav' });
  assert.equal(dead._outbox, undefined);
});
