import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 키캡이 **한 벌인가** (KIT_COMPONENTS_SRS TC-CMP-1 / FR-CMP-10~14).
 *
 * 착수 시 키캡이 **둘**이었다 — `.sc-key`(36자리가 쓴다)와 `kbd`(아무도 안 쓴다).
 * 값도 갈렸다: 배경이 `--sidebar-bg` vs `--border`, 테두리가 `--border` vs
 * `--accent-border`, 글자가 `--text-bright` vs `--accent-text`.
 *
 * `kbd` 는 계획된 치트시트(`production/03-uiux.md:185` — *"메뉴 항목에 `kbd` 열"*)를
 * 위해 미리 넣은 규칙이고 그 기능이 오지 않았다. 킷의 `.ui-key` 가 그 자리를
 * 대신하므로 **죽은 규칙을 남겨 두 벌로 만들지 않는다.**
 */
const ROOT = 'web';
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

function cssFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'vendor') cssFiles(p, out); continue; }
    if (e.endsWith('.css')) out.push(p);
  }
  return out;
}

/** 규칙을 `{file, sel, decls}` 로. */
function rules() {
  const out = [];
  for (const f of cssFiles(ROOT)) {
    for (const m of strip(readFileSync(f, 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@')) continue;
      out.push({ file: f, sel, decls: m[2] });
    }
  }
  return out;
}

test('TC-CMP-1a: 킷이 .ui-key 를 갖는다 (FR-CMP-10)', () => {
  const all = rules();
  assert.ok(all.length > 100, `규칙을 ${all.length}개밖에 못 읽었다 — 검사가 공회전한다`);
  const kit = all.find((r) => r.file === 'web/style-kit.css' && /(^|,)\s*\.ui-key\s*$/.test(r.sel));
  assert.ok(kit, '`style-kit.css` 에 `.ui-key` 규칙이 없다');
  // 크기·모서리·글자는 토큰에서 온다 — 자리마다 px 를 적지 않는다.
  assert.match(kit.decls, /var\(--ui-btn-h-sm\)/, '높이가 `--ui-btn-h-sm` 에서 오지 않는다');
  assert.match(kit.decls, /var\(--ui-radius\)/, '모서리가 `--ui-radius` 에서 오지 않는다');
  assert.match(kit.decls, /var\(--ui-font\)/, '글자가 `--ui-font` 에서 오지 않는다');
});

test('TC-CMP-1b: 키캡은 한 벌이다 — 죽은 `kbd` 규칙이 없다 (FR-CMP-10)', () => {
  const kbd = rules().filter((r) => /(^|,)\s*kbd\s*(,|$)/.test(r.sel));
  assert.deepEqual(kbd.map((r) => `${r.file}: ${r.sel}`), [],
    '아무도 쓰지 않는 `kbd` 규칙이 남아 있다 — 킷의 `.ui-key` 와 두 벌이 된다');
});

test('TC-CMP-1c: .sc-key 는 .ui-key 를 병기하고 ui-btn 은 달지 않는다 (FR-CMP-11 / D-KIT-1)', () => {
  const src = readFileSync('web/js/core/app-settings-keys.js', 'utf8');
  const m = src.match(/createElement\('button'\);\s*\w+\.className\s*=\s*'([^']*)'/);
  assert.ok(m, '`.sc-key` 를 만드는 자리를 찾지 못했다');
  const cls = m[1].split(/\s+/);
  assert.ok(cls.includes('ui-key'), `킷 클래스가 없다: "${m[1]}"`);
  assert.ok(cls.includes('sc-key'), `옛 이름을 지웠다 (D-5 위반): "${m[1]}"`);
  // **`ui-btn` 을 달면 "누르는 것" 이 되어 뜻이 틀린다** — 키캡은 표시다.
  assert.ok(!cls.some((c) => /^ui-btn/.test(c)), `키캡에 버튼 등급이 붙었다: "${m[1]}"`);
});

test('TC-CMP-1d: 킷 밖에 키캡 값이 남지 않는다 (FR-CMP-3)', () => {
  const own = rules().filter((r) => /(^|,)\s*\.sc-key\s*$/.test(r.sel));
  assert.equal(own.length, 1, `.sc-key 의 바탕 규칙이 ${own.length}개다`);
  // 킷이 주는 것(배경·테두리·모서리·글자·높이)은 옛 규칙에서 사라진다.
  for (const prop of ['background', 'border', 'border-radius', 'font-size', 'padding']) {
    assert.doesNotMatch(own[0].decls, new RegExp(`(^|;)\\s*${prop}\\s*:`),
      `\`.sc-key\` 에 킷과 겹치는 \`${prop}\` 가 남았다`);
  }
  // 뜻이 있는 것은 남는다 — 단축키 칸의 최소 폭과 가운데 정렬.
  assert.match(own[0].decls, /min-width/, '`min-width` 는 이 화면의 뜻이므로 남아야 한다');
});

/**
 * 머리글의 **대문자 장식**이 사라졌는가
 * (KIT_COMPONENTS_SRS TC-CMP-6 / FR-CMP-30~34).
 *
 * 착수 시 `text-transform:uppercase` 가 **9규칙**이었다. 한글에는 대소문자가
 * 없으므로 이 장식은 **영문에만 걸린다** — 그 결과 같은 층위의 머리글이
 * `STAGED`(영·대문자)와 `미커밋 변경`(한)으로 갈려 다른 층위처럼 읽힌다.
 *
 * 자간 벌리기(`letter-spacing`)는 대문자 조판의 짝이다. 대문자를 걷고 자간만
 * 남기면 소문자·한글이 헐겁게 벌어져 읽기를 해친다 (FR-CMP-32).
 */
test('TC-CMP-6: CSS 전체에 text-transform:uppercase 가 없다 (FR-CMP-31)', () => {
  const all = rules();
  assert.ok(all.length > 100, `규칙을 ${all.length}개밖에 못 읽었다 — 검사가 공회전한다`);
  const up = all.filter((r) => /text-transform\s*:\s*uppercase/.test(r.decls));
  assert.deepEqual(up.map((r) => `${r.file}: ${r.sel}`), [],
    '대문자 장식이 남았다 — 한글에는 대소문자가 없어 영문에만 걸린다');
});

test('TC-CMP-6a: 아홉 자리에 자간 벌리기가 남지 않았다 (FR-CMP-32)', () => {
  /**
   * **대문자를 걷은 그 규칙**만 본다. 대문자가 없던 자리의 `letter-spacing` 은
   * 이 묶음의 대상이 아니다 — 조판 의도일 수 있고(`.boot-name` 의 `.16em`),
   * 부모의 자간을 **되돌리는** 선언일 수도 있다(`.git-group-bulk{normal}`).
   * 첫 판이 그 구분 없이 걷어 넷을 잘못 지웠다.
   *
   * 남는 둘은 이름으로 적는다 — 적을 수 없으면 걷는다.
   */
  const TOUCHED = ['.git-refs-head', '.gc-target-sect', '.git-stash-preview-head',
    '.git-group-head', '.ag-head', '.ag-group', '.tl-section', '.ce-title', '.sc-group-title'];
  const KEEP = new Set(['.git-group-head', '.tl-section']);
  const bad = rules().filter((r) => TOUCHED.includes(r.sel) && !KEEP.has(r.sel)
    && /(^|;)\s*letter-spacing\s*:/.test(r.decls));
  assert.deepEqual(bad.map((r) => `${r.file}: ${r.sel}`), [],
    '대문자를 걷은 자리에 자간 벌리기가 남았다');
});

test('TC-CMP-6b: 킷이 .ui-section-head 를 갖는다 (FR-CMP-30)', () => {
  const kit = rules().find((r) => r.file === 'web/style-kit.css' && /(^|,)\s*\.ui-section-head\s*$/.test(r.sel));
  assert.ok(kit, '`style-kit.css` 에 `.ui-section-head` 규칙이 없다');
  assert.doesNotMatch(kit.decls, /text-transform/, '킷이 대문자 장식을 갖고 있다');
  assert.doesNotMatch(kit.decls, /letter-spacing/, '킷이 자간 벌리기를 갖고 있다');
  assert.match(kit.decls, /var\(--fs-sm\)/);
  assert.match(kit.decls, /var\(--text-muted\)/);
});

/**
 * 인라인 알림이 **한 벌인가** (KIT_COMPONENTS_SRS TC-CMP-10 / FR-CMP-50~53).
 *
 * 착수 시 12규칙이 같은 일을 했고 값이 갈렸다 — 세로 여백 3·4·6·10px, 가로
 * 8·10px, 색은 `--attn-text`(주의)와 `--text-muted`(기본) 둘.
 *
 * **뜬 것은 알림이 아니다.** `.fe-note`(떠서 사라지는 토스트)와 `.ver-held`
 * (바닥 고정 배너)는 자리가 흐름 밖이고 그림자·페이드를 갖는다 — 인라인 띠와
 * 같은 컴포넌트로 묶으면 둘 다 어정쩡해진다 (§6-예외표 E-3).
 */
const NOTICE = ['git-job-note', 'git-stale-note', 'git-partial-note', 'git-diff-note',
  'git-con-note', 'git-blame-note', 'git-job-opts-note', 'sbx-rt-note', 'fe-offer'];

test('TC-CMP-10a: 킷이 .ui-notice 와 주의 등급을 갖는다 (FR-CMP-50)', () => {
  const kit = rules().filter((r) => r.file === 'web/style-kit.css');
  const base = kit.find((r) => /(^|,)\s*\.ui-notice\s*$/.test(r.sel));
  const attn = kit.find((r) => /(^|,)\s*\.ui-notice-attn\s*$/.test(r.sel));
  assert.ok(base, '`.ui-notice` 가 없다');
  assert.ok(attn, '`.ui-notice-attn` 이 없다');
  assert.match(base.decls, /var\(--ui-font\)/);
  assert.match(base.decls, /var\(--text-muted\)/);
  assert.match(attn.decls, /var\(--attn-text\)/);
  assert.match(attn.decls, /var\(--attn-subtle\)/);
});

test('TC-CMP-10: 알림 아홉이 공통 선언을 킷에서 받는다 (FR-CMP-52)', () => {
  const bad = [];
  for (const r of rules()) {
    if (r.file === 'web/style-kit.css') continue;
    const n = NOTICE.find((x) => new RegExp(`(^|,)\\s*\\.${x}\\s*$`).test(r.sel));
    if (!n) continue;
    // 킷이 주는 것 — 여백·글자·역할색. 남으면 킷을 덮어 수렴하지 않는다.
    for (const p of ['padding', 'font-size']) {
      if (new RegExp(`(^|;)\\s*${p}\\s*:`).test(r.decls)) bad.push(`.${n}: ${p}`);
    }
    if (/(^|;)\s*color\s*:\s*var\(--(?:attn-text|text-muted)\)/.test(r.decls)) bad.push(`.${n}: color`);
    if (/(^|;)\s*background\s*:\s*var\(--attn-subtle\)/.test(r.decls)) bad.push(`.${n}: background`);
  }
  assert.deepEqual(bad, [], `킷과 겹치는 선언이 남았다:\n  ${bad.join('\n  ')}`);
});

test('TC-CMP-10b: 알림 아홉이 킷 클래스를 단다 (FR-CMP-52)', () => {
  // 클래스는 **만드는 자리**에서 단다 (FR-KIT-11 과 같은 규약). 마크업을 훑어
  // 그 이름이 나오는 자리마다 킷이 함께 있는지 본다.
  const files = ['web/index.html'];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'vendor' && e !== 'test') walk(p); continue; }
      if (e.endsWith('.js')) files.push(p);
    }
  };
  walk('web/js');
  const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const bad = [];
  for (const n of NOTICE) {
    // 클래스 목록 안에서 그 이름이 나오는 자리를 모두 본다.
    const re = new RegExp(`class(?:Name)?\\s*=\\s*(["'\`])([^"'\`\\n]*\\b${n}\\b[^"'\`\\n]*)\\1`, 'g');
    const hits = [...src.matchAll(re)].map((m) => m[2]);
    if (!hits.length) { bad.push(`.${n}: 만드는 자리를 찾지 못했다`); continue; }
    for (const h of hits) if (!/\bui-notice\b/.test(h)) bad.push(`.${n}: class="${h}"`);
  }
  assert.deepEqual(bad, [], `킷 클래스를 안 단 알림:\n  ${bad.join('\n  ')}`);
});
