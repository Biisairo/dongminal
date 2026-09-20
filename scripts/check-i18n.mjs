/**
 * 하드코딩 문자열 게이트 (M8_UNIFIED_SRS FR-B-3 · TC-B-1).
 *
 * ## 왜 있는가
 *
 * 문구를 카탈로그로 옮긴 뒤 이 게이트가 없으면 다음 커밋이 그것을 되돌린다 —
 * 한 줄의 `'저장했습니다'` 는 아무 검사에도 걸리지 않고, 걸리지 않는 것은 늘어난다.
 *
 * ## 무엇을 잡는가 (스펙 §3.3 "게이트 규칙")
 *
 *   JS    문자열·템플릿 리터럴(AST)에 든 한글. 주석은 AST 에 없으므로 자연히 지난다
 *   HTML  주석 밖의 텍스트 노드와 title·placeholder·aria-label·alt·value 속성값의 한글
 *   CSS   주석 밖 `content:` 값의 한글 또는 2자 이상의 라틴 단어 (FR-B-6)
 *   가려짐  `t`·`tn` 호출이 지역 변수 `t`/`tn` 에 덮이지 않는다
 *   카탈로그  ko·en 의 키 집합이 같고, 키가 규약(`seg(.seg)+`, `[a-z0-9_]`)이며,
 *            `t('…')`/`tn('…')` 의 리터럴 키가 ko 에 있다
 *
 * ## 예외 등록부 — 줄마다 사유
 *
 * 등록부에 더할 때는 사유를 적는다. 사유 없는 예외는 게이트의 구멍이다.
 *
 * 사용: node scripts/check-i18n.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eslintScope from 'eslint-scope';
import * as espree from 'espree';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KR = /[가-힣ㄱ-ㆎ]/;
const KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** 파일 단위 예외 — 통째로 지나간다. */
const SKIP_FILES = [
  { re: /^web\/js\/i18n\//, why: '카탈로그 자신 — 문장이 사는 자리다' },
  // WORDING_COLOR_SRS FR-WRD-60: 조사 표(`JOSA_*`)의 `을`·`를`·`으로` 는 **문구가
  // 아니라 문법**이다. 카탈로그에 두면 카탈로그의 문장이 자기 조사를 카탈로그에서
  // 찾게 되어 순환한다. 이 파일에는 사용자에게 보이는 문장이 없다 — 생기면 그것은
  // 카탈로그로 간다.
  { re: /^web\/js\/core\/i18n\.js$/, why: '문구 장치 자신 — 조사 표는 문법이지 문장이 아니다' },
  { re: /^web\/js\/test\//, why: '단위 테스트 — 문자열은 검사 대상이 아니라 기대값이다 (FR-B-1 범위 밖)' },
];

/** 호출 단위 예외 — 이 호출의 인자 안에 있는 리터럴은 지나간다. */
const SKIP_CALLS = [
  { test: (c) => c.callee.type === 'MemberExpression' && c.callee.object.type === 'Identifier' && c.callee.object.name === 'console',
    why: '콘솔 로그 — 개발자가 읽는다 (FR-B-1 범위 밖)' },
  { test: (c, file) => file === 'web/js/ui/diag.js' && c.callee.type === 'Identifier' && c.callee.name === 'put',
    why: '진단 오버레이의 로그 줄(`put`) — 콘솔과 같은 성격의 개발자 출력' },
];

/** `throw new Error('…')` — 개발자 오류. 사용자에게 보이지 않는다. */
function isThrownError(anc) {
  for (let i = anc.length - 1; i >= 0; i--) {
    const n = anc[i];
    if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Error') {
      return i > 0 && anc[i - 1].type === 'ThrowStatement';
    }
  }
  return false;
}

/** 속성 단위 예외 — `{"key":…,"where":"…"}` 의 `where` 값. */
const SKIP_PROPS = [
  { file: /^web\/js\/core\/settings-schema\.js$/, prop: 'where',
    why: '문서 필드 — Go 가 같은 바이트를 JSON 으로 읽으므로 키로 바꿀 수 없다 (FR-CFG-2)' },
];

const problems = [];
const say = (file, line, what) => problems.push(`${file}:${line}: ${what}`);

function walkDir(d, out) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split('\\').join('/');

// ── JS ──────────────────────────────────────────────────────────────

function checkJs(file, src) {
  let ast;
  try {
    ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true });
  } catch (e) {
    say(file, e.lineNumber || 0, `파싱 실패: ${e.message}`);
    return;
  }
  const anc = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && SKIP_CALLS.some((s) => s.test(n, file))) return;
    const isStr = (n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral';
    if (isStr) {
      const raw = n.type === 'TemplateLiteral' ? n.quasis.map((q) => q.value.raw).join('') : n.value;
      if (KR.test(raw) && !isThrownError(anc) && !isSkippedProp(file, anc)) {
        say(file, n.loc.start.line, `한글 리터럴이 카탈로그 밖에 있다: ${JSON.stringify(raw).slice(0, 60)}`);
      }
      return;
    }
    anc.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
    anc.pop();
  };
  visit(ast);
}

function isSkippedProp(file, anc) {
  const p = anc[anc.length - 1];
  if (!p || p.type !== 'Property') return false;
  const name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
  return SKIP_PROPS.some((s) => s.file.test(file) && s.prop === name);
}

// ── HTML ────────────────────────────────────────────────────────────

const HTML_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'value'];

function checkHtml(file, src) {
  // 줄 번호를 지키며 주석·스크립트를 지운다.
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let body = src.replace(/<!--[\s\S]*?-->/g, blank).replace(/<script[\s\S]*?<\/script>/g, blank);
  const lines = body.split('\n');
  // 태그 안의 속성값.
  for (const m of body.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    const line = body.slice(0, m.index).split('\n').length;
    for (const a of HTML_ATTRS) {
      const am = tag.match(new RegExp(`\\s${a}="([^"]*)"`));
      if (am && KR.test(am[1])) say(file, line, `${a} 속성의 한글: ${JSON.stringify(am[1]).slice(0, 60)}`);
    }
  }
  // 자기 언어를 말하는 요소는 지난다 — 언어 선택지의 `한국어` 는 어느 로케일에서나 같다 (FR-B-5).
  body = body.replace(/<option\b[^>]*\slang="ko"[^>]*>[^<]*<\/option>/g, blank);
  // 태그 밖의 텍스트.
  body = body.replace(/<[a-zA-Z/][^>]*>/g, blank);
  body.split('\n').forEach((ln, i) => {
    if (KR.test(ln)) say(file, i + 1, `텍스트 노드의 한글: ${JSON.stringify(ln.trim()).slice(0, 60)}`);
  });
  void lines;
}

// ── CSS ─────────────────────────────────────────────────────────────

function checkCss(file, src) {
  const body = src.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '));
  body.split('\n').forEach((ln, i) => {
    const m = ln.match(/content\s*:\s*(['"])(.*?)\1/);
    if (!m) return;
    const v = m[2];
    if (KR.test(v) || /[A-Za-z]{2,}/.test(v)) say(file, i + 1, `CSS content 에 문구가 있다 (FR-B-6): '${v}'`);
  });
}

// ── 카탈로그 ────────────────────────────────────────────────────────

function loadCatalog(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true });
  const out = {};
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
        && n.callee.object.name === 'I18N' && n.callee.property.name === 'register') {
      const obj = n.arguments[1];
      if (!obj || obj.type !== 'ObjectExpression') { say(file, n.loc.start.line, 'register 의 둘째 인자는 객체 리터럴이어야 한다'); return }
      for (const p of obj.properties) {
        const k = p.key.type === 'Literal' ? p.key.value : p.key.name;
        if (k in out) say(file, p.loc.start.line, `키가 겹친다: ${k}`);
        if (!KEY_RE.test(k)) say(file, p.loc.start.line, `키 형식이 규약 밖이다: ${k}`);
        if (!(p.value.type === 'Literal' && typeof p.value.value === 'string')) say(file, p.loc.start.line, `값은 문자열 리터럴이어야 한다: ${k}`);
        out[k] = p.value.value;
      }
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast);
  return out;
}

/** `t('a.b')`·`tn('a.b', …)` 의 리터럴 키. */
function usedKeys(file, src, out) {
  let ast;
  try { ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true }) } catch { return }
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && (n.callee.name === 't' || n.callee.name === 'tn')) {
      const a = n.arguments[0];
      if (a && a.type === 'Literal' && typeof a.value === 'string') out.push({ file, line: n.loc.start.line, key: a.value, plural: n.callee.name === 'tn' });
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast);
}

// ── 가려짐 — `t`·`tn` 이 지역 이름에 덮이면 호출이 조용히 다른 것을 부른다 ──

function checkShadow(file, src) {
  let ast;
  try { ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true, range: true }) } catch { return }
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const visit = (n, parents) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && (n.callee.name === 't' || n.callee.name === 'tn')) {
      let scope = null;
      for (let i = parents.length - 1; i >= 0 && !scope; i--) scope = sm.acquire(parents[i], true);
      for (let s = scope; s; s = s.upper) {
        const v = s.set.get(n.callee.name);
        if (v && v.defs.length && s.type !== 'global') {
          say(file, n.loc.start.line, `${n.callee.name}() 이 지역 이름 \`${n.callee.name}\`(${v.defs[0].name.loc.start.line}행)에 가려진다 — 지역 이름을 바꿔라`);
          break;
        }
        if (v) break;
      }
    }
    parents.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, parents));
      else if (v && typeof v.type === 'string') visit(v, parents);
    }
    parents.pop();
  };
  visit(ast, []);
}

// ── 실행 ────────────────────────────────────────────────────────────

const jsFiles = walkDir(join(ROOT, 'web', 'js'), []).filter((p) => p.endsWith('.js')).map(rel).sort();
const used = [];
for (const f of jsFiles) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  if (!SKIP_FILES.some((s) => s.re.test(f))) checkJs(f, src);
  if (!/^web\/js\/test\//.test(f)) checkShadow(f, src);
  if (!/^web\/js\/(i18n|test)\//.test(f)) usedKeys(f, src, used);
}
checkHtml('web/index.html', readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'));
for (const f of readdirSync(join(ROOT, 'web')).filter((n) => n.endsWith('.css')).sort()) {
  checkCss('web/' + f, readFileSync(join(ROOT, 'web', f), 'utf8'));
}

let ko = {}, en = {};
try { ko = loadCatalog('web/js/i18n/ko.js') } catch (e) { say('web/js/i18n/ko.js', 0, `카탈로그를 읽지 못했다: ${e.message}`) }
try { en = loadCatalog('web/js/i18n/en.js') } catch (e) { say('web/js/i18n/en.js', 0, `카탈로그를 읽지 못했다: ${e.message}`) }
for (const k of Object.keys(ko)) if (!(k in en)) say('web/js/i18n/en.js', 0, `ko 에만 있는 키 (전수 번역, FR-B-1): ${k}`);
// 복수형의 `.one` 은 언어의 것이다 — ko 는 `.other` 만 둔다 (스펙 §3.3 키 규약).
const pluralOne = (k, cat) => k.endsWith('.one') && (k.slice(0, -4) + '.other') in cat;
for (const k of Object.keys(en)) if (!(k in ko) && !pluralOne(k, ko)) say('web/js/i18n/ko.js', 0, `en 에만 있는 키: ${k}`);
for (const u of used) {
  const ok = u.plural ? (`${u.key}.other` in ko) : (u.key in ko);
  if (!ok) say(u.file, u.line, `카탈로그에 없는 키: ${u.key}${u.plural ? '.other' : ''}`);
}

if (problems.length) {
  console.error('i18n 게이트 실패 (FR-B-3):');
  for (const p of problems) console.error('  ' + p);
  console.error(`\n  ${problems.length} 건. 문구는 web/js/i18n/<locale>.js 로, 코드는 t('key') 로.`);
  process.exit(1);
}
console.log(`i18n ok — 한글 리터럴 0 · 카탈로그 ${Object.keys(ko).length} 키 · 호출 ${used.length}`);
