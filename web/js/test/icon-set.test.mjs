import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from './harness.mjs';

/**
 * ICON_SET_SRS TC-ICN-1~7: 아이콘은 선 한 벌(2.25·둥근 끝)이고, 옅은 면은 물체 모양에만 있고, 한 뜻 = 한 아이콘이다.
 *
 * MEANINGS 는 SRS §3.2 표를 옮긴 것이다. 표를 고치면 여기도 고친다.
 * uses 는 쓰는 자리마다 「그 파일에 이 이름이 이렇게 적혀 있다」 는 정규식이다.
 */
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');
const HTML = read('index.html');
const html = (id, sym) => ['index.html', new RegExp(`id="${id}"[^\\n]*?#i-${sym}"`)];

const MEANINGS = [
  { id: 'windowstab', symbols: ['app-window'], face: true, uses: [['js/ui/sidebar-tabs.js', /icon:'app-window'/]] },
  { id: 'repotab', symbols: ['git-repo'], face: true, uses: [['js/ui/sidebar-tabs.js', /icon:'git-repo'/]] },
  { id: 'group', symbols: ['window-group'], face: true, uses: [html('add-group', 'window-group')] },
  { id: 'add', symbols: ['plus'], uses: [html('add-window', 'plus'), html('repo-add', 'plus'), html('slot-add', 'plus'),
    ['js/core/chat-controller.js', /icon:'plus'/], ['js/ui/renderer-pane-wire.js', /icon:'plus'/]] },
  { id: 'remove', symbols: ['minus'], uses: [html('slot-remove', 'minus')] },
  { id: 'sandbox', symbols: ['container'], face: true, uses: [html('add-sandbox-window', 'container'), ['js/ui/sidebar-tabs.js', /icon:'container'/]] },
  { id: 'preset', symbols: ['bookmark'], face: true, uses: [html('add-preset', 'bookmark'), ['js/core/settings-presets.js', /icon:'bookmark'/]] },
  { id: 'presetload', symbols: ['play'], uses: [['js/core/settings-presets.js', /icon:'play'/]] },
  { id: 'close', symbols: ['x'], uses: [html('search-close', 'x'), html('modal-close', 'x'), ['js/ui/kit-modal.js', /icon:'x'/],
    ['js/ui/file-editor-find.js', /iconHTML\('x'\)/], ['js/ui/file-editor-peek.js', /iconHTML\('x'\)/], ['js/ui/file-tree-paint.js', /icon:'x'/],
    ['js/ui/renderer-pane-wire.js', /iconHTML\('x'/], ['js/ui/sidebar-list.js', /UIKit\.icon\('x'/], ['js/core/mobile-controller.js', /UIKit\.icon\('x'\)/],
    ['js/ui/renderer-chrome.js', /drawerOpen\?'x':'menu'/], ['js/core/panel-dock.js', /if\(mobile\) return 'x'/]] },
  { id: 'menu', symbols: ['menu'], uses: [html('m-drawer-toggle', 'menu'), ['js/ui/renderer-chrome.js', /drawerOpen\?'x':'menu'/]] },
  { id: 'more', symbols: ['ellipsis'], uses: [['js/core/chat-controller.js', /icon:'ellipsis'/], ['js/core/chat-views.js', /icon:'ellipsis'/],
    ['js/git/git-diff-pane.js', /UIKit\.icon\('ellipsis'\)/], ['js/core/constants-git-commit.js', /GIT_COMMIT_MORE='ellipsis'/],
    ['js/core/constants-git-remote.js', /GIT_REMOTE_MORE='ellipsis'/], ['js/core/activity-list.js', /UIKit\.icon\('ellipsis'/]] },
  { id: 'disclose', symbols: ['chevron-down', 'chevron-right'], uses: [['js/core/agents-controller.js', /folded\?'chevron-right':'chevron-down'/],
    ['js/ui/file-editor-find.js', /on \? 'chevron-down' : 'chevron-right'/], ['js/ui/ui-kit.js', /open \? 'chevron-down' : 'chevron-right'/],
    ['js/core/activity-list.js', /v\.open\?'chevron-down':'chevron-right'/]] },
  { id: 'step', symbols: ['chevron-left', 'chevron-right'], uses: [html('m-pane-prev', 'chevron-left'), html('m-pane-next', 'chevron-right'),
    ['js/git/git-diff-pane.js', /'next'\?'chevron-right':'chevron-left'/]] },
  { id: 'back', symbols: ['arrow-left', 'arrow-right'], uses: [html('nav-back', 'arrow-left'), html('nav-forward', 'arrow-right'),
    ['js/core/mobile-sheets.js', /UIKit\.icon\('arrow-left'\)/], ['js/ui/doc-render.js', /iconHTML\('arrow-left'\)/]] },
  { id: 'collapse', symbols: ['panel-left-close', 'panel-left-open', 'panel-right-close', 'panel-right-open'], face: true,
    uses: [['js/core/panel-dock.js', /'panel-left-close'/], ['js/core/panel-dock.js', /'panel-right-open'/], ['js/core/layout-dock.js', /icon:'panel-left-close'/]] },
  { id: 'split', symbols: ['columns-2', 'rows-2'], face: true, uses: [['js/ui/renderer-pane-wire.js', /h\?'columns-2':'rows-2'/]] },
  { id: 'keyboard', symbols: ['keyboard'], face: true, uses: [['js/core/constants-term.js', /icon:'keyboard'/]] },
  { id: 'search', symbols: ['search'], face: true, uses: [html('m-search-btn', 'search'), ['index.html', /class="search-icon">[^\n]*#i-search"/]] },
  { id: 'findnav', symbols: ['arrow-up', 'arrow-down'], uses: [html('search-prev', 'arrow-up'), html('search-next', 'arrow-down'),
    ['js/ui/file-editor-find.js', /iconHTML\('arrow-up'\)/], ['js/ui/file-editor-find.js', /iconHTML\('arrow-down'\)/]] },
  { id: 'bell', symbols: ['bell'], face: true, uses: [html('attn-badge', 'bell')] },
  { id: 'dismiss', symbols: ['check-check'], uses: [['js/core/attn-center.js', /icon:'check-check'/]] },
  { id: 'settings', symbols: ['settings'], face: true, uses: [html('settings-btn', 'settings')] },
  { id: 'reload', symbols: ['refresh-cw'], uses: [html('soft-reload-btn', 'refresh-cw'), ['js/core/constants-explorer.js', /EDITOR_TREE_REFRESH='refresh-cw'/]] },
  { id: 'branches', symbols: ['git-branch'], uses: [['js/core/constants-git.js', /key:'branches',\s*icon:'git-branch'/]] },
  { id: 'history', symbols: ['git-history'], uses: [['js/core/constants-git.js', /key:'history',\s*icon:'git-history'/]] },
  { id: 'stash', symbols: ['archive'], face: true, uses: [['js/core/constants-git.js', /key:'stash',\s*icon:'archive'/]] },
  { id: 'console', symbols: ['square-terminal'], face: true, uses: [['js/core/constants-git.js', /key:'console',\s*icon:'square-terminal'/]] },
  { id: 'worktrees', symbols: ['folders'], face: true, uses: [['js/core/constants-git.js', /key:'worktrees',\s*icon:'folders'/]] },
  { id: 'submodules', symbols: ['blocks'], face: true, uses: [['js/core/constants-git.js', /key:'submodules',\s*icon:'blocks'/]] },
  { id: 'fetch', symbols: ['git-fetch'], face: true, uses: [['js/core/constants-git-remote.js', /fetch:'git-fetch'/]] },
  { id: 'pull', symbols: ['arrow-down-to-line'], uses: [['js/core/constants-git-remote.js', /pull:'arrow-down-to-line'/]] },
  { id: 'push', symbols: ['arrow-up-from-line'], uses: [['js/core/constants-git-remote.js', /push:'arrow-up-from-line'/]] },
  { id: 'openfile', symbols: ['square-arrow-out-up-right'], uses: [['js/core/constants-git-changes.js', /openFile:'square-arrow-out-up-right'/]] },
  { id: 'stage', symbols: ['square-plus'], uses: [['js/core/constants-git-changes.js', /stage:'square-plus'/]] },
  { id: 'unstage', symbols: ['square-minus'], uses: [['js/core/constants-git-changes.js', /unstage:'square-minus'/]] },
  { id: 'discard', symbols: ['undo-2'], uses: [['js/core/constants-git-changes.js', /discard:'undo-2'/]] },
  { id: 'treeview', symbols: ['folder-tree'], uses: [['js/core/constants-git-changes.js', /tree:'folder-tree'/]] },
  { id: 'flatview', symbols: ['list'], uses: [['js/core/constants-git-changes.js', /flat:'list'/]] },
  { id: 'historyopts', symbols: ['sliders-horizontal'], uses: [['js/git/history.js', /UIKit\.icon\('sliders-horizontal'\)/]] },
  { id: 'favorite', symbols: ['star'], uses: [['js/core/constants-git-refs.js', /GIT_BR_FAV_MARK='star'/]] },
  { id: 'current', symbols: ['check'], uses: [['js/core/constants-git-refs.js', /GIT_BR_CURRENT_MARK='check'/], ['js/git/git-diff-pane.js', /icon:on\?'check'/]] },
  { id: 'agents', symbols: ['bot'], face: true, uses: [['js/core/activity-list.js', /icon:'bot'/], ['js/core/mobile-nav.js', /UIKit\.icon\('bot'\)/]] },
  { id: 'bg', symbols: ['layers'], face: true, uses: [['js/core/activity-list.js', /icon:'layers'/]] },
  { id: 'runs', symbols: ['workflow'], uses: [['js/core/activity-list.js', /icon:'workflow'/]] },
  { id: 'subagent', symbols: ['corner-down-right'], uses: [['js/core/agents-sub.js', /'corner-down-right'/]] },
  { id: 'working', symbols: ['loader-circle'], uses: [['js/core/constants.js', /WORKING\]:'loader-circle'/]] },
  { id: 'done', symbols: ['circle-check'], uses: [['js/core/constants.js', /DONE\]:'circle-check'/]] },
  { id: 'waiting', symbols: ['hourglass'], face: true, uses: [['js/core/constants.js', /WAITING\]:'hourglass'/]] },
  { id: 'idle', symbols: ['circle-dashed'], uses: [['js/core/constants.js', /IDLE\]:'circle-dashed'/]] },
  { id: 'warn', symbols: ['triangle-alert'], uses: [['js/ui/file-tree-paint.js', /'triangle-alert'/], ['js/ui/run-dashboard.js', /'triangle-alert'/], ['js/ui/runs-panel.js', /'triangle-alert'/]] },
  { id: 'newfile', symbols: ['file-plus'], face: true, uses: [['js/core/constants-explorer.js', /EDITOR_TREE_NEW_FILE='file-plus'/]] },
  { id: 'newdir', symbols: ['folder-plus'], face: true, uses: [['js/core/constants-explorer.js', /EDITOR_TREE_NEW_DIR='folder-plus'/]] },
  { id: 'folder', symbols: ['folder'], face: true, uses: [['js/core/settings-claude.js', /UIKit\.icon\('folder'/]] },
  { id: 'symlink', symbols: ['link'], uses: [['js/core/constants-explorer.js', /EDITOR_TREE_LINK='link'/]] },
  { id: 'copy', symbols: ['copy'], face: true, uses: [html('pf-fp-copy', 'copy')] },
  { id: 'theme', symbols: ['palette'], face: true, uses: [html('custom-toggle', 'palette')] },
  { id: 'reset', symbols: ['list-restart'], uses: [['js/core/settings-shortcuts.js', /icon:'list-restart'/]] },
  { id: 'delete', symbols: ['trash-2'], face: true, uses: [['js/core/settings-access.js', /icon:'trash-2'/], ['js/core/settings-presets.js', /icon:'trash-2'/],
    ['js/core/settings-sandbox.js', /icon:'trash-2'/], ['js/core/chat-human.js', /icon:'trash-2'/], ['js/core/chat-views.js', /icon:'trash-2'/]] },
  { id: 'chattab', symbols: ['messages-square'], face: true, uses: [['js/ui/sidebar-tab-chat.js', /icon:'messages-square'/]] },
  { id: 'room', symbols: ['hash'], uses: [['js/core/chat-controller.js', /'direct'\?'message-square':'hash'/]] },
  { id: 'direct', symbols: ['message-square'], face: true, uses: [['js/core/chat-controller.js', /'direct'\?'message-square':'hash'/],
    ['js/core/chat-controller.js', /icon:'message-square'/]] },
  { id: 'leave', symbols: ['log-out'], uses: [['js/core/chat-human.js', /icon:'log-out'/], ['js/core/chat-views.js', /icon:'log-out'/]] },
  { id: 'kick', symbols: ['user-minus'], uses: [['js/core/chat-human.js', /icon:'user-minus'/]] },
];
// FR-ICN-6 의 예외 — 방향 꺾쇠 관례(D-ICN-6).
const SHARED_OK = new Set(['chevron-right']);

const sprite = HTML.match(/<svg id="ui-sprite"[\s\S]*?<\/svg>/)[0];
const SYMBOLS = new Map([...sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)].map((m) => [m[1], { attrs: m[2], body: m[3] }]));

test('TC-ICN-1: 심볼은 24 격자이고 선·채움·투명도를 스스로 정하지 않는다', () => {
  assert.ok(SYMBOLS.size > 0);
  const bad = [];
  for (const [id, s] of SYMBOLS) {
    if (!/viewBox="0 0 24 24"/.test(s.attrs)) bad.push(`${id}: viewBox`);
    const m = (s.attrs + s.body).match(/\s(stroke|stroke-width|stroke-linecap|stroke-linejoin|fill|opacity)="/);
    if (m) bad.push(`${id}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('TC-ICN-2: 선 2.25·둥근 끝, 옅은 면 한 규칙, 마스크 꺾쇠도 2.25', () => {
  const css = read('style-kit.css');
  const icon = css.match(/\n\.ui-icon\{([^}]*)\}/)[1];
  assert.match(icon, /stroke-width:2\.25;/);
  assert.match(icon, /stroke-linecap:round;/);
  assert.match(icon, /stroke-linejoin:round;/);
  assert.match(icon, /fill:none;/);
  assert.match(icon, /stroke:currentColor;/);
  assert.match(css, /#ui-sprite \.t\{fill:currentColor;stroke:none;opacity:\.18\}/);
  assert.match(css.match(/--ui-chev-right:[^;]*;/)[0], /stroke-width='2\.25' stroke-linecap='round' stroke-linejoin='round'/);
});

test('TC-ICN-3: 물체 모양만 옅은 면(.t)을 갖는다', () => {
  const bad = [];
  for (const m of MEANINGS) for (const id of m.symbols) {
    const s = SYMBOLS.get(id);
    if (!s) continue;
    const has = /class="t"/.test(s.body);
    if (has !== !!m.face) bad.push(`${id}: 면 ${has ? '있음' : '없음'} (표: ${m.face ? '물체' : '기호'})`);
  }
  assert.deepEqual(bad, []);
});

test('TC-ICN-4: 스프라이트 심볼 = 뜻 표의 심볼, 한 심볼은 한 뜻 (예외 chevron-right)', () => {
  const owner = new Map();
  for (const m of MEANINGS) for (const id of m.symbols) owner.set(id, [...(owner.get(id) || []), m.id]);
  assert.deepEqual([...SYMBOLS.keys()].filter((id) => !owner.has(id)).sort(), [], '뜻 표에 없는 심볼(쓰는 곳 없음)');
  assert.deepEqual([...owner.keys()].filter((id) => !SYMBOLS.has(id)).sort(), [], '스프라이트에 없는 심볼');
  const shared = [...owner].filter(([id, ms]) => ms.length > 1 && !SHARED_OK.has(id)).map(([id, ms]) => `${id}: ${ms.join(' · ')}`);
  assert.deepEqual(shared, []);
});

test('TC-ICN-5: 쓰는 자리마다 표의 이름이 적혀 있다', () => {
  const bad = [];
  for (const m of MEANINGS) for (const [rel, re] of m.uses) if (!re.test(read(rel))) bad.push(`${m.id}: ${rel} ${re}`);
  assert.deepEqual(bad, []);
});

// 아이콘 이름을 담는 상수(SRS TC-ICN-6). 새 상수를 만들면 여기 더한다.
const ICON_CONSTS = ['AGENT_STATE_ICON', 'GIT_REMOTE_ICON', 'GIT_REMOTE_MORE', 'GIT_COMMIT_MORE', 'GIT_BR_FAV_MARK', 'GIT_BR_CURRENT_MARK',
  'GIT_FILES_MODE_ICON', 'GIT_ACT_ICON', 'EDITOR_TREE_REFRESH', 'EDITOR_TREE_LINK', 'EDITOR_TREE_NEW_FILE', 'EDITOR_TREE_NEW_DIR'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!['vendor', 'test', 'i18n'].includes(e)) walk(p, out); continue }
    if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
// 비교의 오른쪽(`side==='left'`)은 아이콘 이름이 아니다.
const lits = (expr) => [...expr.matchAll(/(?<![=!]==\s*)'([a-z0-9-]+)'/g)].map((m) => m[1]);

test('TC-ICN-6: 코드가 부르는 아이콘 이름은 모두 스프라이트에 있다', () => {
  const found = [];
  const add = (where, names) => { for (const n of names) found.push([where, n]) };
  for (const p of walk(join(WEB, 'js'))) {
    const rel = relative(WEB, p);
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/UIKit\.(?:icon|iconHTML)\(\s*([^,)]+)/g)) add(rel, lits(m[1]));
    for (const m of src.matchAll(/\bicon\s*:\s*([^,}]+)/g)) add(rel, lits(m[1]));
    for (const c of ICON_CONSTS) for (const m of src.matchAll(new RegExp(`const ${c}\\s*=\\s*(\\{[^}]*\\}|'[^']*')`, 'g'))) add(rel, lits(m[1]));
    const dock = src.match(/function agCollapseIcon\([^)]*\)\{[\s\S]*?\n\}/);
    if (dock) add(rel, lits(dock[0]));
  }
  for (const m of HTML.matchAll(/#i-([a-z0-9-]+)/g)) found.push(['index.html', m[1]]);
  assert.ok(found.length > 80, `아이콘 자리를 너무 적게 찾았다: ${found.length}`);
  for (const c of ICON_CONSTS) assert.ok(found.some(([w]) => w.includes('constants')), c);
  assert.deepEqual(found.filter(([, n]) => !SYMBOLS.has(n)).map(([w, n]) => `${w}: ${n}`), []);
});

test('TC-ICN-7: 패널 접기 아이콘은 쪽과 상태로 고르고, 모바일은 닫기다', () => {
  const f = load(['core/panel-dock.js'], { expose: ['agCollapseIcon'] }).agCollapseIcon;
  assert.equal(f(true, 'left', false), 'panel-left-close');
  assert.equal(f(false, 'left', false), 'panel-left-open');
  assert.equal(f(true, 'right', false), 'panel-right-close');
  assert.equal(f(false, 'right', false), 'panel-right-open');
  assert.equal(f(true, 'right', true), 'x');
});

test('TC-ICN-7: 에이전트 상태 아이콘은 채우지 않는다', () => {
  assert.doesNotMatch(read('js/core/agents-sub.js'), /fill:name===/);
});
