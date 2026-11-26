import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pageScripts, readBundles } from '../bundles-def.mjs';

/**
 * PERF 3.4.12.10 (perf/M3_BOOT_SCOPE.md §3 `uiact`·`chat`, D-47).
 * 사용자 동작 부품의 본체는 `[uiact]`, 채팅 부품은 `[chat]` 이다. 이벤트 안에서 곧바로 답해야 하는 몫과
 * 부팅 때 부르는 몫은 부팅에 남는다. 터치 기기는 addon-webgl 을 싣지 않는다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const defs = readBundles(ROOT);
const boot = pageScripts(html, defs);

const UIACT = ['js/core/layout-dnd-move.js', 'js/core/attn-center-view.js', 'js/ui/path-suggest.js', 'js/ui/term-transfer-io.js'];
const CHAT = ['js/core/edges-mesh.js', 'js/core/constants-chat.js', 'js/core/chat-md.js', 'js/core/chat-log.js', 'js/core/chat-mention.js', 'js/core/chat-views.js', 'js/core/chat-human.js', 'js/core/chat-window-open.js'];
// 부팅 껍데기(동기 몫)와 부팅에 남기는 파일 — 이유는 이슈 3.4.12.10 진행 기록.
const STAY = ['js/core/layout-dnd.js', 'js/core/attn-center.js', 'js/ui/term-transfer.js', 'js/core/chat-window.js',
  'js/core/layout-tab-reopen.js', 'js/core/repo-preview.js', 'js/ui/drop-entries.js'];

test('[uiact] 는 사용자 동작 부품의 본체이고 부팅이 싣지 않는다', () => {
  assert.deepEqual(defs.get('uiact')?.js, UIACT);
  for (const f of UIACT) assert.ok(!boot.includes(f), '부팅이 싣는다: ' + f);
});

test('[chat] 은 채팅 부품과 망 그림 계산을 담고 부팅이 싣지 않는다', () => {
  assert.deepEqual(defs.get('chat')?.js, CHAT);
  for (const f of CHAT) assert.ok(!boot.includes(f), '부팅이 싣는다: ' + f);
});

test('동기 몫과 부팅에 남기는 파일은 부팅 묶음에 있다', () => {
  for (const f of STAY) assert.ok(boot.includes(f), '부팅에 없다: ' + f);
});

test('settings 는 chat 을 needs 로 싣는다 (edges-mesh-view 가 망 그림 계산을 쓴다)', () => {
  const src = readFileSync(join(ROOT, 'web', 'js', 'core', 'settings-controller.js'), 'utf8');
  assert.match(src, /Screens\.register\('settings',\s*\{\s*needs:\s*\[[^\]]*'chat'[^\]]*\][^}]*\}\)/);
});

test('addon-webgl 은 터치 기기(pointer: coarse)가 아닐 때만 vendor 자리에서 동기로 쓴다', () => {
  assert.ok(!html.includes('<script src="vendor/addon-webgl.js"></script>'), 'addon-webgl 을 조건 없이 싣는다');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((m) => m[1].includes('vendor/addon-webgl.js'));
  assert.ok(inline, 'addon-webgl 을 쓰는 인라인 스크립트가 없다');
  assert.match(inline[1], /matchMedia\('\(pointer: coarse\)'\)/);
  assert.match(inline[1], /document\.write\(/);
  // 자리는 종전과 같은 vendor 줄 사이다 — xterm 애드온 뒤, 부팅 묶음 앞.
  assert.ok(inline.index > html.indexOf('<script src="vendor/addon-unicode11.js"></script>'), 'xterm 애드온보다 앞이다');
  assert.ok(inline.index < html.indexOf('<script src="b/pre.js'), '부팅 묶음보다 뒤다');
});
