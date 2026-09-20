#!/usr/bin/env node
/**
 * 스크롤 표면이 **자기 스크롤바를 갖는가** (KIT_APPLICATION_SRS FR-KIT-20).
 *
 * 착수 시 실측은 스크롤 표면 **49** 중 브라우저 기본이 **33** 이었다. README 가
 * Linux·WSL·Windows 를 1급으로 내세우는데, 그 셋에서는 **밝은 회색 네이티브
 * 스크롤바**가 54종 다크 테마 위에 그대로 뜬다. macOS 는 오버레이 스크롤바라
 * 개발자에게 끝까지 안 보이는 종류의 결손이다.
 *
 * ## 무엇을 묻는가
 *
 * CSS 에서 `overflow(-x|-y):auto|scroll` 인 선택자를 모으고, 그 표면마다 셋 중
 * 하나여야 한다:
 *
 *   ① 자기 `::-webkit-scrollbar` 규칙을 갖는다 — 폭 0(숨김)도 여기다
 *   ② 그 표면을 **만드는 자리**가 킷 클래스를 함께 단다
 *      (`.ui-scroll`·`.ui-scroll-sm`·`.ui-modal-body`)
 *   ③ 아래 EXEMPT 에 등록돼 있다 (SRS §6-예외표와 짝이다)
 *
 * ## 왜 CSS 만 보면 안 되는가
 *
 * FR-KIT-11 이 *"클래스를 다는 자리는 그 표면을 **만드는 곳**"* 으로 못박았다 —
 * CSS 에 선택자를 나열하면 킷 규칙이 다시 자라고 "적용됐는가" 를 셀 수 없게
 * 되기 때문이다. 그래서 **CSS 만 보는 게이트는 고친 자리를 전부 다시 잡는다.**
 * 이 검사는 CSS 에서 *표면*을 얻고 `web/**` 의 JS·HTML 에서 *그것을 만드는
 * 자리*를 찾아 짝을 맞춘다.
 *
 * 짚는 자리가 **하나도 없으면** 그 규칙은 죽은 CSS 다 — 그것도 보고한다.
 * (착수 시 `.gpp-note` 하나가 그랬다: 철회된 `FR-GIT-271` 의 잔해였다.)
 *
 * ## 이름을 이어 붙여 만드는 자리
 *
 * 이 저장소는 골격을 접두사로 공유한다 — `GitListTab` 하나가 `'<div class="'+p+
 * '-list">'` 로 Worktrees 와 Submodules 의 목록을 **함께** 만든다. 그 자리를
 * 문자열 그대로 읽으면 `.git-wt-list` 를 아무도 만들지 않는 것으로 읽는다.
 * 그래서 이어 붙인 자리는 `\x01` 로 접고, 접힌 이름은 **같은 나무의 문자열
 * 리터럴**로 되짚는다 (`'git-wt'` + `-list` = `git-wt-list`). 추측이 아니라
 * 소스에 있는 값으로만 잇는다.
 *
 * **캐스케이드를 흉내 내지 않는다** — `check-css-vars`·`check-focus` 와 같은
 * 규약이다. "이 표면에 스크롤바를 주는 규칙이 있는가" 가 이 게이트의 물음이고,
 * 그것이 실제로 보이는지는 e2e(TC-KIT-5)와 사람이 답한다.
 *
 * 사용: node scripts/check-scrollbar.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'web';

/** 킷이 스크롤바를 주는 클래스. 이 목록이 늘면 `style-kit.css` 도 함께 는다. */
const KIT = ['ui-scroll', 'ui-scroll-sm', 'ui-modal-body'];

/**
 * 예외 (FR-KIT-20c · SRS §6-예외표). **재검토 조건 없는 예외는 예외가 아니다**
 * (FR-A11Y-24) — 그래서 왜/언제를 여기 적는다.
 */
const EXEMPT = [
  { sel: '.dr-body table', why: '마크다운 렌더 산출물이라 클래스를 붙일 자리가 없다 — 부모 .dr-body 가 킷을 받는다',
    until: 'doc-render 가 표를 감싸는 래퍼를 만들면' },
  { sel: '.dr-body pre', why: '같음 — 코드 블록도 렌더 산출물이다', until: '같음' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`스크롤바 소유 검사

  web/**/*.css 에서 overflow:auto|scroll 인 표면을 모으고, 그 표면을 만드는
  자리(web/**의 JS·HTML)가 킷 클래스를 함께 다는지 본다.
  킷: ${KIT.map((k) => '.' + k).join(' · ')}

  --list  표면을 판정과 함께 전부 찍는다.`);
  process.exit(0);
}

/** 주석은 CSS 가 아니다 (FR-TOK-28a 와 같은 이유). */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 규칙을 `{선택자, 선언}` 으로 가른다. `@media` 류는 서문을 지나 **안으로** 들어간다. */
function parseRules(css) {
  const out = [];
  let buf = '', i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const sel = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (sel.startsWith('@')) { i++; continue; }
      let j = i + 1, decls = '';
      while (j < css.length && css[j] !== '}' && css[j] !== '{') decls += css[j++];
      out.push({ sel, decls });
      i = j + 1;
      continue;
    }
    if (ch === '}') { buf = ''; i++; continue; }
    buf += ch; i++;
  }
  return out;
}

const selectors = (sel) => sel.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * FR-KIT-20b: **재귀로 돈다.** 착수 시 이 저장소의 CSS 검사 넷이 `readdirSync('web')`
 * 을 비재귀로 돌아 하위 디렉터리를 못 봤다 (감사 패턴 B). 같은 함정에 빠지지 않는다.
 */
function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    // 벤더 자산은 우리 것이 아니다 — 고칠 수 없는 파일을 재면 예외가 자란다.
    if (statSync(p).isDirectory()) { if (e !== 'vendor') walk(p, exts, out); continue; }
    if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

/** `::-webkit-scrollbar…` 를 걷어낸 **바탕 선택자**. */
const barBase = (s) => s.replace(/::-webkit-scrollbar[a-z-]*(:[a-z-]+)?\s*$/, '').trim();

/**
 * 선택자의 **마지막 단순 선택자**에서 표면의 이름을 얻는다 — 그 이름이 곧
 * 마크업에서 찾을 열쇠다. `.run-view .run-graph-wrap` → `run-graph-wrap` ·
 * `body.mobile #sidebar` → `#sidebar`.
 */
function keyOf(sel) {
  const last = sel.split(/\s+|>/).filter(Boolean).pop() || '';
  const id = last.match(/#([\w-]+)/);
  if (id) return { kind: 'id', name: id[1] };
  const cls = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (cls.length) return { kind: 'class', name: cls[cls.length - 1] };
  return null;  // 타입 선택자만 — EXEMPT 가 받는다
}

const cssFiles = walk(ROOT, ['.css']);
const styled = new Set();
const surfaces = [];
let overflowDecls = 0;

for (const f of cssFiles) {
  for (const { sel, decls } of parseRules(strip(readFileSync(f, 'utf8')))) {
    if (/::-webkit-scrollbar/.test(sel)) {
      for (const s of selectors(sel)) styled.add(barBase(s));
      continue;
    }
    if (!/(?:^|;)\s*overflow(?:-x|-y)?\s*:\s*(?:auto|scroll)\b/.test(decls)) continue;
    overflowDecls++;
    for (const one of selectors(sel)) surfaces.push({ file: f, one, key: keyOf(one) });
  }
}

// ── 만드는 자리를 모은다 (JS·HTML) ───────────────────────────────────────
//
// 한 자리는 **클래스 목록 하나**다. 두 모양이 있다:
//   HTML/템플릿   <div class="a b c">   → class 속성의 값
//   JS            className='a b' · classList.add('a') · runDiv('a b')
// 둘 다 "공백으로 갈린 이름들" 이므로 같은 방법으로 읽는다.
const markup = walk(ROOT, ['.js', '.html', '.mjs']).filter((f) => !f.includes('/test/'));
/** 이름 -> [클래스 목록 문자열] */
const sites = new Map();
const addSite = (list) => {
  for (const n of list.split(/\s+/).filter(Boolean)) {
    if (!sites.has(n)) sites.set(n, []);
    sites.get(n).push(list);
  }
};
/** id 이름 -> [같은 태그의 클래스 목록] */
const idSites = new Map();

/**
 * 이어 붙인 자리를 접는다 — `'<div class="'+p+'-list">'` → `class="\x01-list"`.
 * 접는 대상은 **따옴표를 품지 않는 한 조각**뿐이다: 더 욕심내면 서로 다른 두
 * 문자열이 하나로 붙는다.
 */
const JOIN = '\u0001';
const fold = (src) => src.replace(/(['"])\s*\+\s*[^'"+]+?\s*\+\s*\1/g, JOIN);

/** 이름을 이어 붙일 때 쓰이는 조각 — 나무 전체의 짧은 문자열 리터럴. */
const literals = new Set();

for (const f of markup) {
  const src = fold(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/(['"])([\w-]+)\1/g)) literals.add(m[2]);
  // ① `class="…"` / `class='…'` — HTML 과 JS 템플릿이 같은 모양이다.
  for (const m of src.matchAll(/\bclass\s*=\s*(["'])([^"'<>]*)\1/g)) addSite(m[2]);
  // ② `className = '…'` · `classList.add('a','b')`
  for (const m of src.matchAll(/\bclassName\s*=\s*(["'`])([^"'`\n]*)\1/g)) addSite(m[2]);
  // `classList.add('a','b')` 의 인자는 **한 목록**이다 — 하나씩 읽으면 킷을 함께
  // 단 자리가 "킷 없이 단다" 로 잡힌다.
  for (const m of src.matchAll(/\bclassList\.add\(([^)]*)\)/g)) {
    addSite([...m[1].matchAll(/(["'])([^"']*)\1/g)].map((q) => q[2]).join(' '));
  }
  // ③ 이 저장소의 관용 — `runDiv('a b')` 처럼 클래스 목록 하나를 받는 만들개.
  for (const m of src.matchAll(/\b(?:runDiv|div|el)\(\s*(["'])([\w\s-]+)\1\s*\)/g)) addSite(m[2]);
  // ④ id 를 가진 태그의 클래스 (`<div id="attn-center" class="…">`, 순서 무관)
  for (const m of src.matchAll(/<[a-zA-Z][\w-]*\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\bid\s*=\s*(["'])([\w-]+)\1/);
    if (!id) continue;
    const cls = tag.match(/\bclass\s*=\s*(["'])([^"'<>]*)\1/);
    if (!idSites.has(id[2])) idSites.set(id[2], []);
    idSites.get(id[2]).push(cls ? cls[2] : '');
  }
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 파서가 헛돌면
// 목록이 비고 검사는 조용히 초록이 된다.
if (overflowDecls < 20 || styled.size < 2 || sites.size < 100) {
  console.error(`표면 ${overflowDecls} · 스크롤바 규칙 ${styled.size} · 클래스 자리 ${sites.size} 밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

const hasKitToken = (list) => list.split(/\s+/).some((n) => KIT.includes(n));

/**
 * 이름을 만드는 자리. 그대로 적힌 것이 먼저이고, 없으면 **접힌 이름**을 문자열
 * 리터럴로 되짚는다 — `git-wt-list` 는 `\x01-list` 와 리터럴 `'git-wt'` 로 선다.
 */
function joinedSites(name) {
  const direct = sites.get(name);
  if (direct && direct.length) return direct;
  const out = [];
  for (const [tok, lists] of sites) {
    if (!tok.startsWith(JOIN)) continue;
    const tail = tok.slice(JOIN.length);
    // 접두사가 **소스에 있는 값**이어야 한다. 아무 접두사나 허용하면 접미사가
    // 같은 다른 표면(`.gpp-note` ↔ `\x01-note`)까지 통과시킨다.
    if (!name.endsWith(tail) || !literals.has(name.slice(0, name.length - tail.length))) continue;
    out.push(...lists);
  }
  return out;
}
/** 자기 것이거나, 자기를 **끝으로 갖는** 바탕 선택자가 그린다 (`body.mobile #sidebar` ↔ `#sidebar`). */
const hasOwnBar = (s) => styled.has(s) || [...styled].some((b) => b && (s === b || s.endsWith(' ' + b)));
const exemptOf = (s) => EXEMPT.find((e) => e.sel === s);

const bare = [], dead = [], skipped = [], ok = [];
for (const su of surfaces) {
  if (hasOwnBar(su.one)) { ok.push({ ...su, how: '자기' }); continue; }
  const ex = exemptOf(su.one);
  if (ex) { skipped.push({ ...su, ...ex }); continue; }
  if (!su.key) { bare.push({ ...su, why: '타입 선택자 — 이름이 없어 만드는 자리를 찾을 수 없다' }); continue; }
  const found = su.key.kind === 'id' ? idSites.get(su.key.name) : joinedSites(su.key.name);
  if (!found || !found.length) { dead.push(su); continue; }
  const missing = found.filter((list) => !hasKitToken(list));
  if (missing.length) { bare.push({ ...su, why: `만드는 자리 ${missing.length}/${found.length} 이 킷 없이 단다`, missing }); continue; }
  ok.push({ ...su, how: '킷' });
}

if (process.argv.includes('--list')) {
  for (const su of surfaces) {
    const o = ok.find((x) => x.one === su.one && x.file === su.file);
    const mark = o ? (o.how === '킷' ? '킷  ' : '자기') : exemptOf(su.one) ? '예외' : dead.some((d) => d.one === su.one) ? '죽음' : '✗   ';
    console.log(`${mark} ${su.file}: ${su.one}`);
  }
  console.log();
}

// FR-KIT-20c: **건너뛴 수를 찍는다.** 조용한 예외는 예외가 아니라 구멍이다.
if (skipped.length) {
  console.log(`  예외 ${skipped.length}건 (SRS §6-예외표):`);
  for (const s of skipped) console.log(`    ${s.one} — ${s.why} · 언제까지: ${s.until}`);
}

const bad = [];
if (bare.length) {
  bad.push(`✗ 스크롤바가 없는 표면 ${bare.length}개 — 브라우저 기본이 54종 테마 위에 뜬다 (FR-KIT-20)`);
  for (const su of bare) {
    bad.push(`    ${su.file}: ${su.one} — ${su.why}`);
    for (const m of su.missing || []) bad.push(`        class="${m}"`);
  }
  bad.push('');
  bad.push(`  킷 클래스(${KIT.map((k) => '.' + k).join('·')})를 **만드는 자리**에서 함께 다세요 (FR-KIT-11).`);
  bad.push('  붙일 자리가 없으면 이 파일의 EXEMPT 에 **재검토 조건과 함께** 등록하세요.');
}
if (dead.length) {
  bad.push(`✗ 아무도 만들지 않는 스크롤 표면 ${dead.length}개 — 죽은 규칙이다`);
  for (const su of dead) bad.push(`    ${su.file}: ${su.one}`);
  bad.push('');
  bad.push('  규칙을 지우세요. 죽은 CSS 에 킷 클래스를 다는 것은 아무것도 고치지 않습니다.');
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }

console.log(`✓ 스크롤 표면 ${surfaces.length}개 전부 스크롤바를 갖는다 — 킷 ${ok.filter((o) => o.how === '킷').length} · 자기 ${ok.filter((o) => o.how === '자기').length} · 예외 ${skipped.length} (FR-KIT-20)`);
