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
  assert.deepEqual(icons(), { agents: 'bot', bg: 'terminal-bg', runs: 'list-tree', chats: 'message-square' });
});

test('탭 아이콘은 모두 스프라이트에 있다', () => {
  const html = read('index.html');
  for (const name of Object.values(icons())) {
    assert.ok(html.includes(`<symbol id="i-${name}"`), `스프라이트에 i-${name} 이 없다`);
  }
});

test('탭은 같은 폭이고 고른 탭도 넓어지지 않는다', () => {
  const css = read('style.css');
  const rule = (sel) => (css.match(new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + '\\{([^}]*)\\}')) || [])[1] || '';
  assert.match(rule('.ag-tab'), /flex:1 1 0/);
  assert.doesNotMatch(rule('.ag-tab.active'), /flex/);
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
