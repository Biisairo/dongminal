import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * PEER_CHAT_SRS FR-PCH-80·82 (개정) — Activity 탭 줄은 같은 폭의 탭 넷이고, 아이콘이 탭의 뜻을 보인다.
 */
const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(web, p), 'utf8');

const icons = () => Object.fromEntries([...read('js/core/app-activity.js')
  .matchAll(/\{key:'(\w+)', icon:'([\w-]+)'/g)].map((m) => [m[1], m[2]]));

test('탭마다 뜻에 맞는 아이콘이다', () => {
  assert.deepEqual(icons(), { agents: 'bot', bg: 'terminal-bg', runs: 'workflow', chats: 'message-square' });
});

test('탭 아이콘은 모두 스프라이트에 있다', () => {
  const html = read('index.html');
  for (const name of Object.values(icons())) {
    assert.ok(html.includes(`<symbol id="i-${name}"`), `스프라이트에 i-${name} 이 없다`);
  }
});

// PANEL_TEMPLATE_SRS FR-PNT-6 으로 개정: 탭의 폭 규칙은 `.ag-tab` 이 아니라 패널 템플릿의 `.ui-panel-tab`(style-panel.css)이
// 갖는다 — 메인 패널의 탭과 같은 규칙이다. Activity 의 탭은 그 클래스를 함께 단다.
test('탭은 같은 폭이고 고른 탭도 넓어지지 않는다', () => {
  const css = read('style.css');
  const panel = read('style-panel.css');
  const rule = (sel) => (panel.match(new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + '\\{([^}]*)\\}')) || [])[1] || '';
  assert.match(rule('.ui-panel-tab'), /flex:1 1 0/);
  assert.doesNotMatch(rule('.ui-panel-tab.active'), /flex/);
  assert.match(read('js/core/app-activity.js'), /cls:'ag-tab ui-panel-tab'/);
  assert.ok(!css.includes('.ag-tab.active .ag-tab-name{display:inline}'), '고른 탭이 이름을 보인다');
});

// FR-PCH-82 (개정): 레일에서 Chats 는 방 줄만 남는다. 글자가 40px 폭에 한 자씩 꺾이지 않게,
// 소제목·빈 문구·노드 줄·참가자 줄·연결 끊김 문구를 숨긴다.
test('레일의 Chats 는 방 줄만 보인다', () => {
  const css = read('style.css');
  const hide = (css.match(/#agents-panel:not\(\.open\) :is\(([\s\S]*?)\)\{display:none\}/) || [])[1] || '';
  for (const cls of ['.chat-sub-h', '.chat-none', '.chat-node', '.chat-person', '.chat-down']) {
    assert.ok(hide.includes(cls), `레일에서 ${cls} 를 숨기지 않는다`);
  }
  assert.ok(!hide.includes('.chat-room'), '방 줄은 레일에 남아야 한다');
});

// UI_KIT_SRS FR-UIK-5·FR-GLY-5: 아이콘만 있는 탭의 아이콘은 탭 높이에서 파생한다 (× --ui-icon-ratio).
test('탭 아이콘은 탭 높이 × --ui-icon-ratio 다', () => {
  const css = read('style.css');
  const m = css.match(/\n\.ag-tab-icon>\.ui-icon\{([^}]*)\}/);
  assert.ok(m, '.ag-tab-icon>.ui-icon 규칙이 없다');
  assert.match(m[1], /width:calc\(var\(--ui-tab-h\) \* var\(--ui-icon-ratio\)\)/);
  assert.match(m[1], /height:calc\(var\(--ui-tab-h\) \* var\(--ui-icon-ratio\)\)/);
});
