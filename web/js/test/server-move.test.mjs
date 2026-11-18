import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/** vm 안에서 만든 값은 원형이 달라 그대로 견주면 틀린다. */
const plain = (x) => JSON.parse(JSON.stringify(x));

/**
 * HOT_REBIND_SRS TC-HRB-11 — 화면의 이사(FR-HRB-26)와 Settings 의 Server 구역(FR-HRB-40·43·44).
 */

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    dump: () => Object.fromEntries(m),
  };
}

function loc(href) {
  const u = new URL(href);
  const out = { href, protocol: u.protocol, hostname: u.hostname, assigned: null };
  out.assign = (to) => { out.assigned = to };
  return out;
}

function hist() {
  const h = { state: { a: 1 }, replaced: null };
  h.replaceState = (_s, _t, url) => { h.replaced = url };
  return h;
}

test('carry 가 있으면 받아서 localStorage 에 넣고 주소에서 지운다', () => {
  const ctx = load(['core/server-move.js'], { globals: { URL } });
  const st = storage({ keep: 'x' });
  const h = hist();
  const asked = [];
  const did = ctx.serverCarryRestore(loc('http://127.0.0.1:9100/?x=1&carry=tok123#h'), st,
    (p) => { asked.push(p); return { theme: 'dark', 'dm.locale': 'en' } }, h);
  assert.equal(did, true);
  assert.deepEqual(asked, ['/api/server/carry/tok123']);
  assert.deepEqual(st.dump(), { keep: 'x', theme: 'dark', 'dm.locale': 'en' });
  assert.equal(h.replaced, '/?x=1#h');
});

test('carry 가 없으면 아무것도 하지 않는다', () => {
  const ctx = load(['core/server-move.js'], { globals: { URL } });
  const h = hist();
  let asked = false;
  assert.equal(ctx.serverCarryRestore(loc('http://127.0.0.1:9100/?x=1'), storage(), () => { asked = true }, h), false);
  assert.equal(asked, false);
  assert.equal(h.replaced, null);
});

test('carry 를 받지 못해도 주소에서는 지운다 — 새로 고침마다 다시 묻지 않는다', () => {
  const ctx = load(['core/server-move.js'], { globals: { URL } });
  const st = storage();
  const h = hist();
  ctx.serverCarryRestore(loc('http://127.0.0.1:9100/?carry=gone'), st, () => null, h);
  assert.deepEqual(st.dump(), {});
  assert.equal(h.replaced, '/');
});

test('server_moving: localStorage 를 맡기고 같은 호스트 이름의 새 포트로 carry 를 붙여 간다', async () => {
  const ctx = load(['core/server-move.js'], { globals: { URL } });
  const l = loc('http://192.168.1.5:58146/?w=1');
  const posted = [];
  await ctx.serverMove(l, storage({ a: '1', b: '2' }), async (p, b) => {
    posted.push([p, b]);
    return { ok: true, status: 200, data: { token: 'tok9' } };
  }, '9100');
  assert.deepEqual(plain(posted), [['/api/server/carry', { a: '1', b: '2' }]]);
  assert.equal(l.assigned, 'http://192.168.1.5:9100/?carry=tok9');
});

test('server_moving: 맡기지 못해도 새 주소로 간다 — 설정만 옛 주소에 남는다', async () => {
  const ctx = load(['core/server-move.js'], { globals: { URL } });
  const l = loc('http://localhost:58146/');
  await ctx.serverMove(l, storage({ a: '1' }), async () => ({ ok: false, status: 503, data: null }), '9100');
  assert.equal(l.assigned, 'http://localhost:9100/');
});

// ── Settings ▸ Server ──

function el() {
  const h = {};
  return {
    value: '', textContent: '', hidden: false, checked: false, disabled: false,
    addEventListener: (type, fn) => { h[type] = fn },
    fire: (type, e) => h[type](e),
  };
}

function setupPanel({ confirm = true } = {}) {
  const ids = ['srv-now', 'srv-source', 'srv-port', 'srv-expose', 'srv-status', 'srv-apply', 'srv-local'];
  const dom = Object.fromEntries(ids.map((id) => [id, el()]));
  const calls = [];
  const replies = {};
  const moved = [];
  const reply = (method, path, body) => {
    calls.push([method, path, body]);
    return replies[method + ' ' + path] || { ok: true, status: 200, data: null };
  };
  const ctx = load(['core/server-move.js', 'core/app-settings-server.js'], {
    globals: {
      App: function App() {},
      t: (k, p) => k + (p ? JSON.stringify(p) : ''),
      document: { getElementById: (id) => dom[id] || null },
      statusRun: async (_el, msgs, fn) => { const r = await fn(); _el.textContent = r && r.ok ? (msgs.ok || '') : 'FAIL:' + msgs.fail; return !!(r && r.ok) },
      apiGet: async (p) => reply('GET', p),
      apiPost: async (p, b) => reply('POST', p, b),
      UIKit: { ask: async () => confirm },
    },
  });
  const app = new ctx.App();
  app._serverMoveTo = (port) => moved.push(port);
  app._initServerPanel();
  return { app, dom, calls, replies, moved };
}

const bindView = (o) => ({ host: '127.0.0.1', port: '58146', expose: false, url: 'http://127.0.0.1:58146', local: true, source: { host: 'default', port: 'file' }, ...o });

test('Server 구역은 지금 바인드와 출처를 보이고 입력 칸을 채운다', async () => {
  const { app, dom, replies } = setupPanel();
  replies['GET /api/server/bind'] = { ok: true, status: 200, data: bindView() };
  await app._loadServerPanel();
  assert.equal(dom['srv-now'].textContent, '127.0.0.1:58146');
  assert.match(dom['srv-source'].textContent, /srv\.src_file/);
  assert.equal(dom['srv-port'].value, '58146');
  assert.equal(dom['srv-expose'].checked, false);
  assert.equal(dom['srv-apply'].disabled, false);
});

test('루프백이 아닌 화면에서는 적용을 끄고 사유를 보인다', async () => {
  const { app, dom, replies } = setupPanel();
  replies['GET /api/server/bind'] = { ok: true, status: 200, data: bindView({ local: false }) };
  await app._loadServerPanel();
  assert.equal(dom['srv-apply'].disabled, true);
  assert.equal(dom['srv-local'].hidden, false);
});

test('적용: 확인을 거쳐 바뀐 값만 보내고, 포트가 바뀌면 새 주소로 간다', async () => {
  const { app, dom, calls, replies, moved } = setupPanel();
  replies['GET /api/server/bind'] = { ok: true, status: 200, data: bindView() };
  await app._loadServerPanel();
  dom['srv-port'].value = '9100';
  replies['POST /api/server/bind'] = { ok: true, status: 200, data: bindView({ port: '9100' }) };
  await dom['srv-apply'].fire('click');
  assert.deepEqual(plain(calls.at(-1)), ['POST', '/api/server/bind', { port: 9100 }]);
  assert.deepEqual(moved, ['9100']);
});

test('적용: expose 만 바꾸면 이사하지 않고 새 값을 칠한다', async () => {
  const { app, dom, calls, replies, moved } = setupPanel();
  replies['GET /api/server/bind'] = { ok: true, status: 200, data: bindView() };
  await app._loadServerPanel();
  dom['srv-expose'].checked = true;
  replies['POST /api/server/bind'] = { ok: true, status: 200, data: bindView({ host: '0.0.0.0', expose: true, warning: 'W' }) };
  await dom['srv-apply'].fire('click');
  assert.deepEqual(plain(calls.at(-1)), ['POST', '/api/server/bind', { expose: true }]);
  assert.deepEqual(moved, []);
  assert.equal(dom['srv-now'].textContent, '0.0.0.0:58146');
});

test('적용: 확인에서 물리면 보내지 않는다. 바뀐 것이 없어도 보내지 않는다', async () => {
  const { app, dom, calls, replies } = setupPanel({ confirm: false });
  replies['GET /api/server/bind'] = { ok: true, status: 200, data: bindView() };
  await app._loadServerPanel();
  const n = calls.length;
  await dom['srv-apply'].fire('click');
  dom['srv-port'].value = '9100';
  await dom['srv-apply'].fire('click');
  assert.equal(calls.length, n);
});

test('server_moving 은 한 번만 이사한다', () => {
  const { app, moved } = setupPanel();
  app._onServerMoving({ port: '9100' });
  app._onServerMoving({ port: '9100' });
  assert.deepEqual(moved, ['9100']);
});
