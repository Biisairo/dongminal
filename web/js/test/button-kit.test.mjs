import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * 한 줄에 나란히 서는 버튼들이 **같은 등급인가**
 * (KIT_APPLICATION_SRS TC-KIT-7 / FR-KIT-17 · `AUDIT-uiux.md` §1.6).
 *
 * **소스를 직접 본다.** 첫 판은 e2e 로 재려고 마크업을 검사 안에서 지었는데,
 * 그것은 기대값을 스스로 적고 그것과 견주는 일이라 **무엇도 재지 않는다** —
 * 변경 전 코드에서도 초록이었다. 한 줄의 등급이 같은지는 마크업을 만드는 자리
 * 하나에 다 적혀 있으므로, 그 자리를 읽는 것이 맞다.
 *
 * 착수 시 실측: `.fe-offer-go` 22px · `.fe-offer-no` **20px** · `.fe-offer-x` 22px.
 * `.fe-offer-no` 만 **CSS 규칙이 하나도 없는 맨 `<button>`** 이었다 (UA 기본).
 */
const SIZE = /\bui-btn-(sm|lg)\b/;

/** `<button …>` 태그에서 클래스 목록을 꺼낸다. */
function buttonsOf(src) {
  return [...src.matchAll(/<button\b[^>]*>/g)].map((m) => {
    const c = m[0].match(/class="([^"]*)"/);
    return { tag: m[0], cls: c ? c[1] : '' };
  });
}

test('TC-KIT-7: .fe-offer 한 줄의 버튼 셋이 같은 크기 등급이다 (FR-KIT-17)', () => {
  const src = readFileSync('web/js/ui/file-editor.js', 'utf8');
  const row = buttonsOf(src).filter((b) => /\bfe-offer-/.test(b.cls));
  // 파서가 헛돌면 검사가 조용히 초록이 된다 (M6 §4-A-1).
  assert.ok(row.length >= 3, `.fe-offer 의 버튼을 ${row.length}개밖에 못 읽었다`);

  const sizes = row.map((b) => (b.cls.match(SIZE) || [null])[0]);
  const names = row.map((b) => (b.cls.match(/fe-offer-[\w-]+/) || ['?'])[0]);
  assert.equal(new Set(sizes).size, 1,
    `크기 등급이 갈린다: ${names.map((n, i) => `${n}=${sizes[i]}`).join(' · ')}`);
  // 등급이 **없는** 것이 하나라도 있으면 UA 기본으로 떨어진다 — 착수 시의 결함이다.
  assert.ok(sizes.every(Boolean), `크기 등급이 없는 버튼이 있다: ${names.join(' · ')}`);
});

test('TC-KIT-7a: 한 줄에 서는 다른 버튼 묶음도 등급이 갈리지 않는다', () => {
  // 같은 규약을 쓰는 다른 줄들. 한 자리만 고치면 다음 자리가 같은 모양으로 샌다.
  const ROWS = [
    ['web/js/git/panel-changes.js', /\bgit-job-(?:cancel|copy|close)\b/],
    ['web/js/git/submodules.js', /\bgit-sub-(?:bulk|cancel)\b/],
  ];
  for (const [file, re] of ROWS) {
    const row = buttonsOf(readFileSync(file, 'utf8')).filter((b) => re.test(b.cls));
    assert.ok(row.length >= 2, `${file}: 버튼을 ${row.length}개밖에 못 읽었다`);
    const sizes = row.map((b) => (b.cls.match(SIZE) || [null])[0]);
    assert.equal(new Set(sizes).size, 1, `${file}: 크기 등급이 갈린다 (${sizes.join(' · ')})`);
    assert.ok(sizes.every(Boolean), `${file}: 크기 등급이 없는 버튼이 있다`);
  }
});
