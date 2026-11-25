import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoLoadOrder } from '../../../scripts/bundles-def.mjs';

/**
 * REFACTOR PROD2 §8 (R-ACS-1~3): `tool-cmd.js`(옛 `app-cmd.js`, REFACTOR3_FE_APPCTL_SRS 9j) 는 원격 명령, `ws-sync-controller.js`(옛 `app-ws-sync.js`,
 * REFACTOR3_FE_APPCTL_SRS 9f) 는 워크스페이스 동기화다. 메서드는 두 파일에 겹치지 않고, 둘을 합치면 나누기 전의 33개와 같다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return']);
const methods = (f) => [...readFileSync(join(JS, f), 'utf8').matchAll(/^ {2}(?:async )?([_a-zA-Z][_a-zA-Z0-9]*)\(/gm)]
  .map((m) => m[1]).filter((n) => !KEYWORDS.has(n));

const SYNC = ['_restoreBegin', '_restoreLive', '_restoreNote', '_restoreVoid', '_restoreEnd', '_subscribeCommands',
  '_wsDefer', '_onWorkspaceChanged', '_onToolForeground', '_fgMap', '_fgApply', '_fgRepaint', '_applyRemoteWorkspace'];
// 채널 토픽이 준 워크스페이스 본문을 적용기로 넘기는 자리 (CHANNEL_PROTOCOL C2b). 아래 33 은 그 전 이름으로 센다.
const SYNC_TOPIC = ['_onWorkspaceTopic'];
// 나눈 뒤에 생긴 적용기의 단계 (REFACTOR3_FE_REST3_SRS FR-FR3-2, D-FR3-7). 아래 33 은 나누기 전 이름으로 센다.
const SYNC_STEPS = ['_reapDeadTools', '_reconcileIncoming', '_viewKeep', '_mergeUnseen', '_viewRestore'];

test('워크스페이스 동기화 메서드는 ws-sync-controller.js 에 있다', () => {
  assert.deepEqual(methods('core/ws-sync-controller.js').filter((n) => n !== 'constructor').sort(), [...SYNC, ...SYNC_STEPS, ...SYNC_TOPIC].sort());
});

// PERF 3.4.12.5: 원격 명령은 부팅 껍데기 `tool-cmd.js` 와 `remote` 묶음의 본체 `tool-cmd-remote.js` 로 갈렸다.
// 껍데기의 `_execRemote` 는 묶음을 싣는 입구이고, 옛 `_execRemote` 의 본문은 본체의 `_execRemoteNow` 다 — 33 은 그것을 하나로 센다.
test('tool-cmd.js·tool-cmd-remote.js 에는 원격 명령만 남고, 합치면 33개다', () => {
  const shell = methods('core/tool-cmd.js');
  const cmd = [...shell, ...methods('core/tool-cmd-remote.js').filter((n) => n !== '_execRemoteNow')];
  for (const m of SYNC) assert.ok(!cmd.includes(m), m + ' 가 tool-cmd 에 남았다');
  assert.deepEqual(shell.sort(), ['_echoResult', '_execRemote', '_findTabById']);
  assert.ok(cmd.includes('_execRemote') && cmd.includes('_focusLocation'));
  assert.equal(new Set([...cmd, ...SYNC]).size, 33);
  assert.equal(cmd.length + SYNC.length, 33);
});

test('ws-sync-controller.js 는 tool-cmd.js 바로 뒤에 실린다', () => {
  const order = repoLoadOrder(join(JS, '..', '..'));
  assert.equal(order.indexOf('js/core/ws-sync-controller.js'), order.indexOf('js/core/tool-cmd.js') + 1);
});
