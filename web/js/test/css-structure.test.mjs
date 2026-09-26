import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

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

test('FEU-24: style-git-views.css 에 Runs·사이드바 탭·백그라운드 규칙이 없다', () => {
  const bad = rules(['web/style-git-views.css'])
    .filter((r) => /(^|[\s,>+~])(\.runs?-|\.run-view|\.bg-|#sb-tabs|\.sb-tab)/.test(r.sel))
    .map((r) => r.sel);
  assert.deepEqual(bad, [], 'git 과 무관한 선택자가 git 뷰 파일에 남았다');
});

test('FEU-24: 옮긴 파일이 git 뷰 바로 뒤에서 읽힌다 — 캐스케이드 순서를 보존한다', () => {
  const html = readFileSync('web/index.html', 'utf8');
  const order = [...html.matchAll(/<link rel="stylesheet" href="(style[\w-]*\.css)/g)].map((m) => m[1]);
  const at = (n) => order.indexOf(n);
  assert.ok(at('style-runs.css') > 0, 'style-runs.css 링크가 없다');
  assert.ok(at('style-sidebar.css') > 0, 'style-sidebar.css 링크가 없다');
  assert.equal(at('style-runs.css'), at('style-git-views.css') + 1, `순서: ${order.join(' → ')}`);
  assert.equal(at('style-sidebar.css'), at('style-runs.css') + 1, `순서: ${order.join(' → ')}`);
  assert.equal(at('style-editor.css'), at('style-sidebar.css') + 1, `순서: ${order.join(' → ')}`);
  assert.ok(rules(['web/style-runs.css']).some((r) => r.sel === '.runs-row'), '.runs-row 가 style-runs.css 에 없다');
  assert.ok(rules(['web/style-runs.css']).some((r) => r.sel === '.bg-row'), '.bg-row 가 style-runs.css 에 없다');
  assert.ok(rules(['web/style-sidebar.css']).some((r) => /\.sb-tab\b/.test(r.sel)), '.sb-tab 이 style-sidebar.css 에 없다');
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

const HANDLES = ['#sb-handle', '#agents-handle', '.ed-ex-handle', '.slot-handle', '.sh'];

test('FEU-29: 리사이즈 손잡이의 히트 영역은 킷 한 자리가 그린다', () => {
  const all = rules();
  const kit = all.find((r) => r.file === 'web/style-kit.css' && r.sel === '.ui-resize-handle::before');
  assert.ok(kit, '킷에 `.ui-resize-handle::before` 가 없다');
  assert.match(kit.decls, /content\s*:/);
  assert.match(kit.decls, /var\(--ui-resize-hit\)/, '히트 폭이 토큰에서 오지 않는다');
  const bad = all.filter((r) => r.file !== 'web/style-kit.css' && /::before/.test(r.sel)
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
