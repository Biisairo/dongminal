import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

// vm 컨텍스트에서 만든 배열은 이쪽과 realm 이 달라 엄격 비교가 프로토타입에서 갈린다.
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * ATTENTION_FIRING_SRS 묶음 D — 한 컴퓨터에서 한 번 (FR-ATD-3·7·8).
 *
 * 창은 낼 수 있는 종류만 청구하고, 승낙받은 것만 낸다. 청구가 실패하면 낸다 —
 * 중복은 침묵보다 낫다. 번호가 없는 알람(옛 서버)은 청구 없이 낸다.
 */

function setup({ desktop = true, blocked = false, permission = 'granted', sound = true, active = true, reply } = {}) {
  const posts = [];
  const ctx = load(['core/app-attn-claim.js'], {
    globals: {
      App: function App() {},
      Notification: { permission },
      navigator: { userActivation: { hasBeenActive: active } },
      apiPost: async (path, body) => {
        posts.push({ path, body });
        return reply ? reply(body) : { ok: true, status: 200, data: { granted: body.kinds } };
      },
    },
  });
  const a = new ctx.App();
  a.attnDesktop = desktop;
  a.attnDesktopBlocked = blocked;
  a.attnSound = sound;
  const fired = [];
  a._attnDesktopNotify = (reason, toolId) => fired.push(['banner', reason, toolId]);
  a._attnBeep = () => fired.push(['sound']);
  return { a, posts, fired };
}

test('승낙받은 종류만 낸다 (FR-ATD-4)', async () => {
  const { a, posts, fired } = setup({ reply: () => ({ ok: true, status: 200, data: { granted: ['sound'] } }) });
  await a._attnAnnounce('done', 't1', 9);
  assert.deepEqual(plain(posts), [{ path: '/api/tools/attention/claim', body: { seq: 9, kinds: ['banner', 'sound'] } }]);
  assert.deepEqual(fired, [['sound']]);
});

test('다른 창이 다 맡았으면 아무것도 내지 않는다', async () => {
  const { a, fired } = setup({ reply: () => ({ ok: true, status: 200, data: { granted: [] } }) });
  await a._attnAnnounce('done', 't1', 9);
  assert.deepEqual(fired, []);
});

test('낼 수 없는 종류는 청구하지 않는다 (V-ATD-6)', async () => {
  for (const opts of [{ permission: 'default' }, { desktop: false }, { blocked: true }]) {
    const { a, posts } = setup({ ...opts });
    await a._attnAnnounce('done', 't1', 1);
    assert.deepEqual(plain(posts[0].body.kinds), ['sound'], JSON.stringify(opts));
  }
  for (const opts of [{ sound: false }, { active: false }]) {
    const { a, posts } = setup({ ...opts });
    await a._attnAnnounce('done', 't1', 1);
    assert.deepEqual(plain(posts[0].body.kinds), ['banner'], JSON.stringify(opts));
  }
});

test('낼 것이 없으면 청구도 없다', async () => {
  const { a, posts, fired } = setup({ desktop: false, sound: false });
  await a._attnAnnounce('done', 't1', 1);
  assert.equal(posts.length, 0);
  assert.deepEqual(fired, []);
});

test('청구가 실패하면 낸다 (V-ATD-7)', async () => {
  for (const res of [{ ok: false, status: 0, data: null }, { ok: false, status: 500, data: null }, { ok: true, status: 200, data: null }]) {
    const { a, fired } = setup({ reply: () => res });
    await a._attnAnnounce('waiting', 't2', 3);
    assert.deepEqual(fired, [['banner', 'waiting', 't2'], ['sound']], JSON.stringify(res));
  }
});

test('번호가 없는 알람은 청구 없이 낸다 (V-ATD-7 · FR-ATD-8)', async () => {
  const { a, posts, fired } = setup();
  await a._attnAnnounce('done', 't1', undefined);
  assert.equal(posts.length, 0);
  assert.deepEqual(fired, [['banner', 'done', 't1'], ['sound']]);
});

test('userActivation 이 없는 브라우저는 조작이 있었던 것으로 본다', async () => {
  const posts = [];
  const ctx = load(['core/app-attn-claim.js'], {
    globals: {
      App: function App() {}, Notification: { permission: 'denied' }, navigator: {},
      apiPost: async (path, body) => { posts.push(body); return { ok: true, status: 200, data: { granted: [] } } },
    },
  });
  const a = new ctx.App();
  a.attnDesktop = true; a.attnDesktopBlocked = false; a.attnSound = true;
  await a._attnAnnounce('done', 't1', 1);
  assert.deepEqual(plain(posts[0].kinds), ['sound']);
});
