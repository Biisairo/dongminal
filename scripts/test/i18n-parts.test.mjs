import assert from 'node:assert/strict';
import { test } from 'node:test';

import { i18nFlagged, partFile, partProblems } from '../i18n-parts.mjs';

/**
 * PERF 3.4.12.9 — 언어 카탈로그 조각의 게이트 (D-46, M3_BOOT_SCOPE §6).
 *   조각 키는 그 묶음 파일에서만 쓰인다 · 조각의 ko/en 키 집합이 같다 · 한 묶음에서만 쓰는 키는 부팅에 남지 않는다 ·
 *   조각이 있는 묶음과 `i18n:true` 등록이 맞는다.
 */
const BUNDLES = new Set(['pre', 'boot', 'git', 'settings', 'diag']);

function input(over = {}) {
  const places = new Map(Object.entries({
    'core.ok': ['boot'],
    'git.title': ['git'],
    'git.n': ['git'],
    'shared.x': ['git', 'settings'],
    'html.x': ['html'],
    'diag.x': ['diag'],
    ...(over.places || {}),
  }).map(([k, v]) => [k, new Set(v)]));
  return {
    base: { ko: ['core.ok', 'shared.x', 'html.x', 'diag.x', 'err.a'], en: ['core.ok', 'shared.x', 'html.x', 'diag.x', 'err.a'] },
    parts: new Map([['git', { ko: ['git.title', 'git.n.other'], en: ['git.title', 'git.n.one', 'git.n.other'] }]]),
    places: (k) => places.get(k.replace(/\.(other|one)$/, '')) || new Set(),
    dynamic: (k) => k.startsWith('err.'),
    bundles: BUNDLES,
    flagged: new Set(['git']),
    unfragmented: new Set(['diag']),
    ...over,
  };
}

test('맞는 배치는 문제가 없다', () => {
  assert.deepEqual(partProblems(input()), []);
});

test('조각 키가 다른 묶음에서도 쓰이면 잡는다', () => {
  const p = partProblems(input({ parts: new Map([['git', { ko: ['git.title', 'git.n.other', 'shared.x'], en: ['git.title', 'git.n.other', 'shared.x'] }]]),
    base: { ko: ['core.ok', 'html.x', 'diag.x'], en: ['core.ok', 'html.x', 'diag.x'] } }));
  assert.equal(p.length, 1);
  assert.match(p[0], /shared\.x/);
});

test('조각 키가 부팅·index.html·동적 조립에서 쓰이면 잡는다', () => {
  for (const k of ['core.ok', 'html.x', 'err.a']) {
    const base = { ko: ['shared.x', 'diag.x', 'core.ok', 'html.x', 'err.a'].filter((x) => x !== k), en: ['shared.x', 'diag.x', 'core.ok', 'html.x', 'err.a'].filter((x) => x !== k) };
    const parts = new Map([['git', { ko: ['git.title', 'git.n.other', k], en: ['git.title', 'git.n.other', k] }]]);
    assert.equal(partProblems(input({ base, parts })).length, 1, k);
  }
});

test('조각의 ko/en 키 집합이 다르면 잡는다(복수형 .one 은 en 의 것)', () => {
  const p = partProblems(input({ parts: new Map([['git', { ko: ['git.title', 'git.n.other'], en: ['git.n.one', 'git.n.other'] }]]) }));
  assert.equal(p.length, 1);
  assert.match(p[0], /git\.title/);
});

test('한 언어의 조각만 있으면 잡는다', () => {
  const p = partProblems(input({ parts: new Map([['git', { ko: ['git.title', 'git.n.other'], en: null }]]) }));
  assert.equal(p.length, 1);
});

test('한 지연 묶음에서만 쓰는 키가 부팅 카탈로그에 남으면 잡는다(등록부 밖 묶음은 지난다)', () => {
  const base = { ko: ['core.ok', 'shared.x', 'html.x', 'diag.x', 'git.title'], en: ['core.ok', 'shared.x', 'html.x', 'diag.x', 'git.title'] };
  const parts = new Map([['git', { ko: ['git.n.other'], en: ['git.n.other'] }]]);
  const p = partProblems(input({ base, parts }));
  assert.equal(p.length, 1);
  assert.match(p[0], /git\.title/);
});

test('조각과 i18n 등록이 어긋나면 잡는다', () => {
  assert.equal(partProblems(input({ flagged: new Set() })).length, 1, '조각은 있는데 등록 표시가 없다');
  assert.equal(partProblems(input({ flagged: new Set(['git', 'settings']) })).length, 1, '등록 표시는 있는데 조각이 없다');
});

test('정의에 없는 묶음·부팅 묶음의 조각은 잡는다', () => {
  for (const b of ['nope', 'boot', 'pre']) {
    const parts = new Map([...input().parts, [b, { ko: [], en: [] }]]);
    assert.ok(partProblems(input({ parts, flagged: new Set(['git', b]) })).length >= 1, b);
  }
});

test('같은 키가 부팅과 조각에 함께 있으면 잡는다', () => {
  const base = { ko: ['core.ok', 'shared.x', 'html.x', 'diag.x', 'git.title'], en: ['core.ok', 'shared.x', 'html.x', 'diag.x', 'git.title'] };
  assert.ok(partProblems(input({ base })).some((p) => /겹친다/.test(p)));
});

test('조각 파일 이름과 등록 표시 읽기', () => {
  assert.deepEqual(partFile('git.ko.js'), { bundle: 'git', locale: 'ko' });
  assert.equal(partFile('ko.js'), null);
  assert.equal(partFile('git.fr.js'), null);
  const js = "Screens.register('git',{css:true,needs:['cm'],i18n:true,tab:(at)=>x});\n"
    + "Screens.register('v',{bundle:'plain',i18n:true});\nScreens.register('search');\nScreens.register('run',{css:true});";
  assert.deepEqual([...i18nFlagged(js)].sort(), ['git', 'plain']);
});
