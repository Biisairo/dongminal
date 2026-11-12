import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * TELEGRAM_BRIDGE_SRS FR-TGB-1·3·10 — 설정창 Telegram 패널.
 *
 *   FR-TGB-3  token 칸은 서버 값으로 채우지 않는다. 저장에 성공하면 비운다.
 *   FR-TGB-10 등록 코드는 만든 응답에서만 보이고, 서버에 살아 있는 코드가 없으면 거둔다.
 */
function el() {
  const h = {};
  return {
    value: '', textContent: '', hidden: false, checked: false,
    addEventListener: (type, fn) => { h[type] = fn },
    fire: (type, e) => h[type](e),
  };
}

function setup() {
  const ids = ['panel-telegram', 'modal-overlay', 'tg-enabled', 'tg-bot', 'tg-account', 'tg-unpair',
    'tg-silence', 'tg-token', 'tg-token-save', 'tg-token-status', 'tg-pair-make', 'tg-pair-status',
    'tg-pair-box', 'tg-pair-code', 'tg-pair-remain', 'tg-silence-save', 'tg-silence-status'];
  const dom = Object.fromEntries(ids.map((id) => [id, el()]));
  const calls = [];
  const replies = {};
  const reply = (method, path, body) => {
    calls.push([method, path, body]);
    return replies[method + ' ' + path] || { ok: true, status: 200, data: null };
  };
  const ctx = load(['core/app-peers.js', 'core/app-settings-telegram.js'], {
    globals: {
      App: function App() {},
      t: (k, p) => k + (p ? JSON.stringify(p) : ''),
      document: { getElementById: (id) => dom[id] || null, activeElement: null },
      statusRun: async (_el, _msgs, fn) => fn(),
      apiGet: async (p) => reply('GET', p),
      apiPut: async (p, b) => reply('PUT', p, b),
      apiPost: async (p, b) => reply('POST', p, b),
      apiDel: async (p) => reply('DELETE', p),
    },
  });
  const app = new ctx.App();
  app.timers = { every: () => ({ stop() {} }) };
  app._initTelegramPanel();
  return { app, dom, calls, replies };
}

const view = (o) => ({ enabled: false, tokenSet: false, botName: '', paired: false, silenceMin: 5, pair: null, ...o });

test('token 칸은 서버 값으로 채우지 않고, 저장에 성공하면 비운다', async () => {
  const { app, dom, calls, replies } = setup();
  replies['GET /api/telegram'] = { ok: true, status: 200, data: view({ tokenSet: true, botName: 'good_bot' }) };
  await app._loadTelegramPanel();
  assert.equal(dom['tg-token'].value, '');
  assert.equal(dom['tg-bot'].textContent, 'tg.bot_set{"name":"@good_bot"}');

  dom['tg-token'].value = ' 111:abc ';
  replies['PUT /api/telegram/token'] = { ok: false, status: 400, data: null };
  dom['tg-token-save'].fire('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['PUT', '/api/telegram/token', { token: '111:abc' }]));
  assert.equal(dom['tg-token'].value, ' 111:abc ', '실패하면 고치도록 남긴다');

  replies['PUT /api/telegram/token'] = { ok: true, status: 200, data: view({ tokenSet: true, botName: 'other_bot' }) };
  dom['tg-token-save'].fire('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(dom['tg-token'].value, '');
  assert.equal(dom['tg-bot'].textContent, 'tg.bot_set{"name":"@other_bot"}');
});

test('빈 token 은 보내지 않는다', async () => {
  const { dom, calls } = setup();
  dom['tg-token-save'].fire('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
});

test('등록 코드는 만든 응답에서만 보이고, 등록이 끝나면 거둔다', async () => {
  const { app, dom, replies } = setup();
  const exp = new Date(Date.now() + 600_000).toISOString();
  app._tg = view({ tokenSet: true });
  replies['POST /api/telegram/pair'] = { ok: true, status: 200, data: { code: '123456', expires: exp } };
  dom['tg-pair-make'].fire('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(dom['tg-pair-box'].hidden, false);
  assert.equal(dom['tg-pair-code'].value, '/pair 123456');

  replies['GET /api/telegram'] = { ok: true, status: 200, data: view({ tokenSet: true, paired: true, pair: { expires: exp } }) };
  await app._tgRead();
  assert.equal(dom['tg-pair-box'].hidden, false, '서버에 코드가 살아 있으면 그대로 보인다');

  replies['GET /api/telegram'] = { ok: true, status: 200, data: view({ tokenSet: true, paired: true }) };
  await app._tgRead();
  assert.equal(dom['tg-pair-box'].hidden, true);
  assert.equal(dom['tg-pair-code'].value, '');
  assert.equal(dom['tg-account'].textContent, 'tg.paired');
  assert.equal(dom['tg-unpair'].hidden, false);
});
