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

const icons = () => Object.fromEntries([...read('js/core/activity-list.js')
  .matchAll(/\{key:'(\w+)', icon:'([\w-]+)'/g)].map((m) => [m[1], m[2]]));

test('탭마다 뜻에 맞는 아이콘이다', () => {
  // CHAT_WINDOW_SRS FR-CW-40 으로 개정: 이전 — chats: 'message-square' 도 있었다 / 지금 — 채팅은 메인 패널이다 / 이유 — D-7.
  // ICON_SET_SRS §3.2 로 개정: 이전 — bg: 'terminal-bg'(자작, Console 과 닮았다) / 지금 — 'layers'(뒤에 깔려 도는 것) / 이유 — D-ICN-6.
  assert.deepEqual(icons(), { agents: 'bot', bg: 'layers', runs: 'workflow' });
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
  const css = read('style-activity.css');   // REFACTOR3_FE_REST4_SRS FU-11: Activity 규칙은 style.css 에서 갈라진 조각에 있다
  const panel = read('style-panel.css');
  const rule = (sel) => (panel.match(new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + '\\{([^}]*)\\}')) || [])[1] || '';
  assert.match(rule('.ui-panel-tab'), /flex:1 1 0/);
  assert.doesNotMatch(rule('.ui-panel-tab.active'), /flex/);
  // REFACTOR3_FE_BASE_SRS FR-FEB-22 로 개정: 이전 — 탭을 app-activity.js 가 만들었다 / 지금 — ActivityTabBar(activity-tab-bar.js) / 이유 — 탭 줄을 TabBar 의 하위로 옮겼다.
  assert.match(read('js/core/activity-tab-bar.js'), /cls:'ag-tab ui-panel-tab'/);
  assert.ok(!css.includes('.ag-tab.active .ag-tab-name{display:inline}'), '고른 탭이 이름을 보인다');
});

// FR-PCH-82 (개정): 레일에서 Chats 는 방 줄만 남는다. 글자가 40px 폭에 한 자씩 꺾이지 않게,
// 소제목·빈 문구·노드 줄·참가자 줄·연결 끊김 문구를 숨긴다.
test('레일의 Chats 는 방 줄만 보인다', () => {
  const css = read('style-activity.css');   // REFACTOR3_FE_REST4_SRS FU-11: Activity 규칙은 style.css 에서 갈라진 조각에 있다
  // REFACTOR3_FE_REST4_SRS FU-8 로 개정: 이전 — `#agents-panel:not(.open)` / 지금 — 레일 표식 `#agents-panel[data-rail]` / 이유 — 레일 상태를 표식 하나로.
  const hide = (css.match(/#agents-panel\[data-rail\] :is\(([\s\S]*?)\)\{display:none\}/) || [])[1] || '';
  for (const cls of ['.chat-sub-h', '.chat-none', '.chat-node', '.chat-person', '.chat-down']) {
    assert.ok(hide.includes(cls), `레일에서 ${cls} 를 숨기지 않는다`);
  }
  assert.ok(!hide.includes('.chat-room'), '방 줄은 레일에 남아야 한다');
});

// UI_KIT_SRS FR-UIK-5·FR-GLY-5: 아이콘만 있는 탭의 아이콘은 탭 높이에서 파생한다 (× --ui-icon-ratio).
test('탭 아이콘은 탭 높이 × --ui-icon-ratio 다', () => {
  const css = read('style-activity.css');   // REFACTOR3_FE_REST4_SRS FU-11: Activity 규칙은 style.css 에서 갈라진 조각에 있다
  const m = css.match(/\n\.ag-tab-icon>\.ui-icon\{([^}]*)\}/);
  assert.ok(m, '.ag-tab-icon>.ui-icon 규칙이 없다');
  assert.match(m[1], /width:calc\(var\(--ui-tab-h\) \* var\(--ui-icon-ratio\)\)/);
  assert.match(m[1], /height:calc\(var\(--ui-tab-h\) \* var\(--ui-icon-ratio\)\)/);
});
