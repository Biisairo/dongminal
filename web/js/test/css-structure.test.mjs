import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readBundles } from '../../../scripts/bundles-def.mjs';

/**
 * CSS 의 **자리**가 이름으로 찾아지는가 (OPTIMIZE_REFACTOR_SRS FR-OPT-13-1).
 *
 * FEU-24: Runs·사이드바 탭·백그라운드 종료 규칙이 `style-git-views.css` 뒤에
 * 붙어 있었다 — git 과 무관한 선택자라 파일 이름으로 찾을 수 없었다.
 * FEU-29: git 뷰의 툴바와 리사이즈 손잡이의 히트 영역이 자리마다 복제돼 있었고
 * 빈 규칙 둘이 남아 있었다.
 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

function cssFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'vendor') cssFiles(p, out); continue; }
    if (e.endsWith('.css')) out.push(p);
  }
  return out;
}

/** 규칙을 `{file, sel, decls}` 로 (@-블록 안의 규칙도 한 겹 벗겨 읽는다). */
function rules(files = cssFiles('web')) {
  const out = [];
  for (const f of files) {
    for (const m of strip(readFileSync(f, 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@')) continue;
      out.push({ file: f, sel, decls: m[2] });
    }
  }
  return out;
}

const sels = (r) => r.sel.split(',').map((s) => s.trim());

/**
 * 캐스케이드 순서. 부팅 CSS 는 index.html 의 `<link>` 순서이고, 화면 묶음의 CSS(`b/<이름>.css`)는 로더가 head 끝에
 * 붙이므로 그 모두의 뒤다 — 묶음 안에서는 web/bundles.txt 의 순서다 (PERF D-30, 3.4.6).
 */
function cssOrder() {
  const html = readFileSync('web/index.html', 'utf8');
  const boot = [...html.matchAll(/<link rel="stylesheet" href="(style[\w-]*\.css)/g)].map((m) => m[1]);
  const lazy = [...readBundles('.').values()].flatMap((b) => b.css).filter((f) => !boot.includes(f));
  return { boot, all: [...boot, ...lazy] };
}

test('FEU-24: style-git-views.css 에 Runs·사이드바 탭·백그라운드 규칙이 없다', () => {
  // REFACTOR3_FE_REST5_SRS FR-FR5-1: git 뷰는 두 조각(`style-git-views.css`·`style-git-tabs.css`)이다.
  const bad = rules(['web/style-git-views.css', 'web/style-git-tabs.css'])
    .filter((r) => /(^|[\s,>+~])(\.runs?-|\.run-view|\.bg-|#sb-tabs|\.sb-tab)/.test(r.sel))
    .map((r) => r.sel);
  assert.deepEqual(bad, [], 'git 과 무관한 선택자가 git 뷰 파일에 남았다');
});

test('FEU-24: 옮긴 파일이 코어 조각 바로 뒤에서 읽힌다 — git 뷰 CSS 는 git 묶음으로 갔다 (PERF 3.4.6)', () => {
  const order = cssOrder().boot;
  const at = (n) => order.indexOf(n);
  assert.ok(at('style-runs.css') > 0, 'style-runs.css 링크가 없다');
  assert.ok(at('style-sidebar.css') > 0, 'style-sidebar.css 링크가 없다');
  assert.equal(at('style-git-tabs.css'), -1, 'git 뷰 CSS 는 부팅에 실리지 않는다');
  assert.equal(at('style-runs.css'), at('style-system.css') + 1, `순서: ${order.join(' → ')}`);
  assert.equal(at('style-sidebar.css'), at('style-runs.css') + 1, `순서: ${order.join(' → ')}`);
  assert.equal(at('style-editor.css'), at('style-sidebar.css') + 1, `순서: ${order.join(' → ')}`);
  assert.ok(rules(['web/style-runs.css']).some((r) => r.sel === '.runs-row'), '.runs-row 가 style-runs.css 에 없다');
  assert.ok(rules(['web/style-runs.css']).some((r) => r.sel === '.bg-row'), '.bg-row 가 style-runs.css 에 없다');
  assert.ok(rules(['web/style-sidebar.css']).some((r) => /\.sb-tab\b/.test(r.sel)), '.sb-tab 이 style-sidebar.css 에 없다');
});

// REFACTOR3_FE_REST4_SRS FU-18 (TC-FR4-2): 백그라운드 행의 바탕 규칙은 `style-runs.css` 한 파일에 있다.
// 이전: 바탕(`.bg-row`·`.bg-name`·`.bg-cwd`)은 style.css, 종료 단추는 style-runs.css 에 나뉘어 있었다.
test('TC-FR4-2: 백그라운드 행의 바탕 규칙은 style-runs.css 에만 있다', () => {
  const own = /^(\.bg-row|\.bg-row:hover|\.bg-name|\.bg-cwd)$/;
  // 쉼표는 맨 위 층에서만 가른다 — 레일 규칙의 `:is(.ag-card,.bg-row,…)` 안쪽은 바탕 규칙이 아니다.
  const top = (sel) => { const out = []; let d = 0, cur = ''; for (const c of sel) { if (c === '(') d++; if (c === ')') d--; if (c === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += c; } out.push(cur.trim()); return out; };
  const where = rules().filter((r) => top(r.sel).some((s) => own.test(s))).map((r) => `${r.file}: ${r.sel}`);
  assert.ok(where.length >= 4, `바탕 규칙을 못 찾았다:\n  ${where.join('\n  ')}`);
  assert.deepEqual(where.filter((w) => !w.startsWith('web/style-runs.css:')), [], '바탕 규칙이 다른 파일에도 있다');
});

// REFACTOR3_FE_REST4_SRS FU-8 (TC-FR4-4): 레일 상태는 패널 루트의 표식 `data-rail` 하나다.
// 이전: 규칙마다 `html.sb-collapsed body:not(.mobile) …` · `body:not(.mobile) #agents-panel:not(.open) …` 를 다시 적었다.
test('TC-FR4-4: CSS 에 옛 레일 상태 선택자가 없고, 첫 프레임의 표식이 index.html 에 있다', () => {
  const old = rules().filter((r) => /html\.sb-collapsed\b|#agents-panel:not\(\.open\)/.test(r.sel)).map((r) => `${r.file}: ${r.sel}`);
  assert.deepEqual(old, [], '옛 레일 상태 선택자가 남았다');
  assert.ok(rules().filter((r) => r.sel.includes('[data-rail]')).length >= 20, '레일 표식 규칙을 못 읽었다');
  const html = readFileSync('web/index.html', 'utf8');
  assert.match(html, /<div id="agents-panel" class="ui-panel"[^>]* data-rail>/, '#agents-panel 은 처음부터 레일이다');
  const at = html.indexOf('<div id="sidebar"');
  const boot = html.slice(at, html.indexOf('</script>', at));
  assert.match(boot, /classList\.contains\('sb-collapsed'\)\)document\.getElementById\('sidebar'\)\.setAttribute\('data-rail',''\)/,
    '#sidebar 여는 태그 뒤에서 접힘을 보고 표식을 붙인다');
  assert.ok(html.indexOf('<div id="sb-head"', at) > html.indexOf('</script>', at), '표식은 사이드바 내용보다 먼저 선다');
});

// REFACTOR3_FE_REST4_SRS FU-9 (TC-FR4-5): 레일 숨김 목록의 클래스는 화면에 실제로 있다 — 죽은 선택자가 다시 쌓이지 않는다.
// 이전: Activity 레일 숨김 목록에 웹 어디에도 없는 `.ag-title`·`.ag-refresh` 가 남아 있었다 (PROD3 DOC-15).
function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'test') jsFiles(p, out); continue; }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

test('TC-FR4-5: 레일 숨김 목록의 클래스는 모두 JS·HTML 에 있다', () => {
  const hide = rules().filter((r) => r.sel.includes('[data-rail]') && /(^|;)\s*display\s*:\s*none\b/.test(r.decls));
  const names = new Set();
  for (const r of hide) {
    // 표식 뒤가 레일 안에서 숨기는 것이다. 표식 앞(`#sidebar`·`.ui-panel`)은 패널 자신이다.
    for (const part of r.sel.split('[data-rail]').slice(1)) for (const m of part.matchAll(/\.([a-zA-Z][\w-]*)/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 10, `레일 숨김 목록을 못 읽었다 (${names.size}개) — 검사가 공회전한다`);
  const src = [readFileSync('web/index.html', 'utf8'), ...jsFiles('web/js').map((f) => readFileSync(f, 'utf8'))].join('\n');
  const dead = [...names].filter((n) => !new RegExp(`(^|[^\\w-])${n}(?![\\w-])`).test(src)).sort();
  assert.deepEqual(dead, [], '레일 숨김 목록에 화면에 없는 클래스가 있다');
});

// REFACTOR3_FE_REST4_SRS FU-11 (TC-FR4-7): style.css 는 원래 순서의 연속 구간으로 나뉘었다. **<link> 순서가 곧 캐스케이드다.**
// 이전: style.css 한 파일이 2,545줄이었다.
const CORE_PIECES = ['style.css', 'style-main-panel.css', 'style-workspace.css', 'style-activity.css',
  'style-modal.css', 'style-status.css', 'style-mobile.css', 'style-system.css'];
test('TC-FR4-7: 코어 조각은 키트(style-kit·style-kit-controls) 뒤·style-runs 앞에 원래 순서로 실리고, 각각 500줄 이하다', () => {
  const order = cssOrder().boot;
  const at = order.indexOf('style.css');
  assert.equal(order[at - 1], 'style-kit-controls.css', `순서: ${order.join(' → ')}`);
  assert.deepEqual(order.slice(at, at + CORE_PIECES.length), CORE_PIECES, `순서: ${order.join(' → ')}`);
  // PERF 3.4.6: 그 자리에 있던 style-git*.css 는 git 묶음이다.
  assert.equal(order[at + CORE_PIECES.length], 'style-runs.css', `순서: ${order.join(' → ')}`);
  const long = CORE_PIECES.map((f) => [f, readFileSync(join('web', f), 'utf8').split('\n').length - 1]).filter(([, n]) => n > 500);
  assert.deepEqual(long, [], '500줄을 넘는 코어 조각');
});

test('FEU-29: git 뷰 툴바 여섯이 골격 한 규칙을 나눈다', () => {
  const BARS = ['.git-diff-bar', '.git-img-bar', '.git-con-bar', '.git-br-bar', '.git-hist-bar', '.git-stash-bar'];
  const all = rules();
  const holders = all.filter((r) => /border-bottom\s*:/.test(r.decls) && sels(r).some((s) => BARS.includes(s)));
  assert.equal(holders.length, 1, `골격을 적은 규칙이 ${holders.length}개다:\n  ${holders.map((r) => r.sel).join('\n  ')}`);
  for (const b of BARS) assert.ok(sels(holders[0]).includes(b), `${b} 가 공용 골격에 없다`);
  // 뷰별 규칙에는 골격과 **다른 것**(gap·글자 크기·줄바꿈)만 남는다.
  const SKELETON = ['flex', 'display', 'align-items', 'padding', 'border-bottom'];
  const dup = [];
  for (const r of all) {
    if (r === holders[0] || !sels(r).some((s) => BARS.includes(s))) continue;
    for (const p of SKELETON) if (new RegExp(`(^|;)\\s*${p}\\s*:`).test(r.decls)) dup.push(`${r.sel}: ${p}`);
  }
  assert.deepEqual(dup, [], '뷰별 규칙이 골격을 다시 적는다');
});

/** 킷은 두 조각이다 (REFACTOR3_FE_REST5_SRS FR-FR5-1). */
const KIT_FILES = ['web/style-kit.css', 'web/style-kit-controls.css'];

// REFACTOR3_FE_REST5_SRS FR-FR5-1 (TC-FR5-1): 500줄을 넘던 CSS 넷을 원래 순서의 연속 구간 둘로 나눴다.
// 조각은 <link> 에서 바로 이어 실린다 — **이 순서가 곧 캐스케이드다.** 이전: 한 파일(565~824줄)이었다.
const SPLIT_PAIRS = [['style-kit.css', 'style-kit-controls.css'], ['style-git.css', 'style-git-commit.css'],
  ['style-git-views.css', 'style-git-tabs.css'], ['style-editor.css', 'style-editor-tools.css']];
test('TC-FR5-1: 나눈 CSS 조각은 바로 이어 실리고 각각 500줄 이하다', () => {
  const order = cssOrder().all;
  for (const [a, b] of SPLIT_PAIRS) {
    assert.ok(order.indexOf(a) >= 0, `${a} 링크가 없다`);
    assert.equal(order.indexOf(b), order.indexOf(a) + 1, `${b} 가 ${a} 바로 뒤가 아니다: ${order.join(' → ')}`);
  }
  assert.equal(order.indexOf('style-git-views.css'), order.indexOf('style-git-commit.css') + 1, `순서: ${order.join(' → ')}`);
  const long = SPLIT_PAIRS.flat().map((f) => [f, readFileSync(join('web', f), 'utf8').split('\n').length - 1]).filter(([, n]) => n > 500);
  assert.deepEqual(long, [], '500줄을 넘는 조각');
});

const HANDLES = ['#sb-handle', '#agents-handle', '.ed-ex-handle', '.slot-handle', '.sh'];

test('FEU-29: 리사이즈 손잡이의 히트 영역은 킷 한 자리가 그린다', () => {
  const all = rules();
  const kit = all.find((r) => KIT_FILES.includes(r.file) && r.sel === '.ui-resize-handle::before');
  assert.ok(kit, '킷에 `.ui-resize-handle::before` 가 없다');
  assert.match(kit.decls, /content\s*:/);
  assert.match(kit.decls, /var\(--ui-resize-hit\)/, '히트 폭이 토큰에서 오지 않는다');
  const bad = all.filter((r) => !KIT_FILES.includes(r.file) && /::before/.test(r.sel)
    && HANDLES.some((h) => new RegExp(`${h.replace('.', '\\.')}(?![\\w-])[^,]*::before`).test(r.sel))
    && /content\s*:/.test(r.decls)).map((r) => `${r.file}: ${r.sel}`);
  assert.deepEqual(bad, [], '손잡이가 히트 영역을 자기 규칙으로 다시 그린다');
});

test('FEU-29: 손잡이 다섯이 만드는 자리에서 킷 클래스를 단다', () => {
  const html = readFileSync('web/index.html', 'utf8');
  for (const id of ['sb-handle', 'agents-handle']) {
    const m = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(m, `#${id} 가 index.html 에 없다`);
    assert.match(m[0], /class="[^"]*\bui-resize-handle\b/, `#${id}: ${m[0]}`);
  }
  const js = {
    'slot-handle': 'web/js/ui/renderer-layout.js',
    'ed-ex-handle': 'web/js/ui/renderer-layout.js',
    'sh': 'web/js/ui/renderer-pane.js',
  };
  for (const [cls, f] of Object.entries(js)) {
    const src = readFileSync(f, 'utf8');
    const hits = [...src.matchAll(/className\s*=\s*'([^']*)'/g)].map((m) => m[1])
      .filter((c) => c.split(/\s+/).includes(cls));
    assert.ok(hits.length, `${f}: .${cls} 를 만드는 자리를 찾지 못했다`);
    for (const h of hits) assert.ok(h.split(/\s+/).includes('ui-resize-handle'), `${f}: className='${h}'`);
  }
});

test('FEU-29: 빈 규칙이 없다', () => {
  const empty = rules().filter((r) => !r.decls.trim()).map((r) => `${r.file}: ${r.sel}{}`);
  assert.deepEqual(empty, []);
});

test('RAIL_CHAT_USAGE_SRS FR-RCU-7 (TC-RCU-5): 레일의 두 줄 줄임 규칙은 모두 줄 높이 1.3 이다', () => {
  const clamp = rules().filter((r) => r.sel.includes('[data-rail]') && /line-clamp:\s*2/.test(r.decls));
  assert.ok(clamp.length >= 4, `두 줄 줄임 규칙이 ${clamp.length}개 — 선택자가 바뀌었다`);
  const bad = clamp.filter((r) => !/line-height:\s*1\.3\s*(;|$)/.test(r.decls)).map((r) => `${r.file}: ${r.sel}`);
  assert.deepEqual(bad, []);
});
