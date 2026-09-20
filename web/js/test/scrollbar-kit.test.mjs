import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 스크롤바가 **한 벌인가** (KIT_APPLICATION_SRS TC-KIT-2·4 / FR-KIT-4·5 · D-KIT-2·3).
 *
 * 게이트(`scripts/check-scrollbar.mjs`)와 **다른 것을 묻는다**. 게이트의 물음은
 * *"구르는 표면마다 스크롤바가 있는가"*(덮는 범위)이고, 여기의 물음은
 * *"그 스크롤바가 한 벌인가"*(값의 통일)다. 착수 시 범위는 33개가 비었고 값은
 * 폭 넷·손잡이 둘로 갈려 있었다 — 둘은 따로 새고 따로 고쳐진다.
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

/** `::-webkit-scrollbar*` 규칙만 골라 `{file, sel, decls}` 로 돌려준다. */
function barRules() {
  const out = [];
  for (const f of cssFiles(ROOT)) {
    const css = strip(readFileSync(f, 'utf8'));
    for (const m of css.matchAll(/([^{}]*::-webkit-scrollbar[^{}]*)\{([^{}]*)\}/g)) {
      out.push({ file: f, sel: m[1].trim().replace(/\s+/g, ' '), decls: m[2] });
    }
  }
  return out;
}

/** 킷이 소유하는 파일. 다른 파일에 스크롤바 값이 있으면 한 벌이 아니다. */
const KIT_FILE = 'web/style-kit.css';

test('TC-KIT-2: 스크롤바의 폭은 두 눈금과 0(숨김)뿐이다 (FR-KIT-4)', () => {
  const rules = barRules();
  // 파서가 헛돌면 검사가 조용히 초록이 된다 (M6 §4-A-1).
  assert.ok(rules.length >= 5, `스크롤바 규칙을 ${rules.length}개밖에 못 읽었다 — 검사가 공회전한다`);

  const allowed = new Set(['var(--ui-scroll-w)', 'var(--ui-scroll-w-sm)', '0']);
  const bad = [];
  for (const r of rules) {
    for (const m of r.decls.matchAll(/(?:^|;)\s*(width|height)\s*:\s*([^;]+)/g)) {
      const v = m[2].trim();
      if (!allowed.has(v)) bad.push(`${r.file}: ${r.sel} — ${m[1]}:${v}`);
    }
  }
  // 착수 시 4px·6px·8px 셋이었고 6px 여섯 중 셋은 좁은 목록, 셋은 본문이라
  // **같은 값이 두 뜻을 덮고 있었다** (D-KIT-2).
  assert.deepEqual(bad, [], `폭이 토큰에서 오지 않는다:\n  ${bad.join('\n  ')}`);
});

test('TC-KIT-4: 손잡이 색을 킷 밖에서 적지 않는다 (FR-KIT-5 · D-KIT-3)', () => {
  const bad = [];
  for (const r of barRules()) {
    if (!/-thumb/.test(r.sel)) continue;
    if (!/(?:^|;)\s*background\s*:/.test(r.decls)) continue;
    if (r.file === KIT_FILE) continue;
    bad.push(`${r.file}: ${r.sel}`);
  }
  // 손으로 그린 열넷이 전부 `--border` 를 쓰고 hover 가 없었다. 색이 갈리면
  // 눈금이 아니라 두 벌이 된다.
  assert.deepEqual(bad, [], `킷 밖에서 손잡이 색을 적는다:\n  ${bad.join('\n  ')}`);
});

test('TC-KIT-4a: 킷의 손잡이는 --text-dim 이고 hover 가 있다 (D-KIT-3)', () => {
  const kit = barRules().filter((r) => r.file === KIT_FILE);
  const thumb = kit.find((r) => /-thumb/.test(r.sel) && !/:hover/.test(r.sel));
  const hover = kit.find((r) => /-thumb:hover/.test(r.sel));
  assert.ok(thumb, '킷에 손잡이 규칙이 없다');
  assert.ok(hover, '킷에 손잡이 hover 규칙이 없다 — 다수(--border) 쪽으로 접으면 잃는 것이 이것이다');
  assert.match(thumb.decls, /background:\s*var\(--text-dim\)/);
  assert.match(hover.decls, /background:\s*var\(--text-muted\)/);
  // 두 눈금이 색을 **함께** 쓴다 (FR-KIT-5).
  for (const k of ['ui-scroll', 'ui-scroll-sm', 'ui-modal-body']) {
    assert.ok(thumb.sel.includes('.' + k + '::'), `${k} 가 손잡이 색을 못 받는다`);
    assert.ok(hover.sel.includes('.' + k + '::'), `${k} 가 hover 를 못 받는다`);
  }
});

test('TC-KIT-2a: 눈금 토큰은 배율을 먹지 않는다 (FR-KIT-6)', () => {
  const kit = strip(readFileSync(KIT_FILE, 'utf8'));
  for (const name of ['--ui-scroll-w', '--ui-scroll-w-sm']) {
    const m = kit.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    assert.ok(m, `${name} 가 세워지지 않았다`);
    // 스크롤바는 글자를 담는 상자가 아니다 — `--ui-radius` 를 뺀 것과 같은 근거.
    assert.doesNotMatch(m[1], /--fs-scale/, `${name} 에 배율이 걸렸다`);
  }
});
