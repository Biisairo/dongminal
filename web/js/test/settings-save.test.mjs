import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-5-2 — 설정 저장 파이프라인의 남은 두 갈래.
 *
 *   ① 비행이 던져도 다음 저장은 새 비행이다 (`_settingsChain` 이 거부된 약속으로 남지 않는다).
 *   ② FEC-M3: 방송의 `origin` 이 이 창이면 GET 을 건너뛴다. 없으면(옛 서버) 종전대로 받는다.
 */
function setup() {
  const calls = { put: [], get: 0 };
  let putImpl = async () => ({ ok: true });
  const ctx = load(['core/app-settings.js'], {
    globals: {
      App: function App() {},
      SETTINGS_SCHEMA: [],
      SETTINGS_SAVE_FAIL: 'fail',
      apiPut: (path, body) => { calls.put.push(path); return putImpl(path, body) },
      apiGet: async () => { calls.get++; return { ok: true, text: '{}', data: {} } },
    },
  });
  const app = new ctx.App();
  app.clientId = 'c-self';
  app._restoreBegin = () => 1;
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app._settingsApply = () => {};
  return { app, calls, setPut: (f) => { putImpl = f } };
}

test('saveSettings: 비행이 던져도 다음 저장은 새 비행으로 나간다', async () => {
  const { app, calls, setPut } = setup();
  setPut(async () => { throw new Error('boom') });
  await assert.rejects(app.saveSettings(), /boom/);
  setPut(async () => ({ ok: true }));
  assert.equal(await app.saveSettings(), true);
  assert.equal(calls.put.length, 2);
  assert.equal(app._settingsLocalPending(), false);
});

test('saveSettings: PUT 은 clientId 를 싣는다', async () => {
  const { app, calls } = setup();
  await app.saveSettings();
  assert.deepEqual([...calls.put], ['/api/settings?clientId=c-self']);
});

test('FEC-M3: 자기 origin 의 방송은 GET 하지 않고, 남의 것·origin 없는 것은 GET 한다', async () => {
  const { app, calls } = setup();
  await app._onSettingsChanged({ origin: 'c-self' });
  assert.equal(calls.get, 0);
  await app._onSettingsChanged({ origin: 'c-other' });
  assert.equal(calls.get, 1);
  await app._onSettingsChanged({});
  assert.equal(calls.get, 2);
});
