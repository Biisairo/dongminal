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
