import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * REFACTOR PROD2 §8 (R-ACS-1~3): `app-cmd.js` 는 원격 명령, `app-ws-sync.js` 는 워크스페이스
 * 동기화다. 메서드는 두 파일에 겹치지 않고, 둘을 합치면 나누기 전의 33개와 같다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return']);
const methods = (f) => [...readFileSync(join(JS, f), 'utf8').matchAll(/^ {2}(?:async )?([_a-zA-Z][_a-zA-Z0-9]*)\(/gm)]
  .map((m) => m[1]).filter((n) => !KEYWORDS.has(n));

const SYNC = ['_restoreBegin', '_restoreLive', '_restoreNote', '_restoreVoid', '_restoreEnd', '_subscribeCommands',
  '_wsDefer', '_onWorkspaceChanged', '_onToolForeground', '_fgMap', '_fgApply', '_fgRepaint', '_applyRemoteWorkspace'];

test('워크스페이스 동기화 메서드는 app-ws-sync.js 에 있다', () => {
  assert.deepEqual(methods('core/app-ws-sync.js').sort(), [...SYNC].sort());
});

test('app-cmd.js 에는 원격 명령만 남고, 합치면 33개다', () => {
  const cmd = methods('core/app-cmd.js');
  for (const m of SYNC) assert.ok(!cmd.includes(m), m + ' 가 app-cmd.js 에 남았다');
  assert.ok(cmd.includes('_execRemote') && cmd.includes('_focusLocation'));
  assert.equal(new Set([...cmd, ...SYNC]).size, 33);
  assert.equal(cmd.length + SYNC.length, 33);
});

test('index.html 은 app-ws-sync.js 를 app-cmd.js 바로 뒤에 싣는다', () => {
  const html = readFileSync(join(JS, '..', 'index.html'), 'utf8');
  assert.match(html, /js\/core\/app-cmd\.js\?v=__ASSETV__"><\/script>\n<script src="js\/core\/app-ws-sync\.js\?v=__ASSETV__"><\/script>/);
});
