import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cssProblems, loadOrder, pageScripts, parseBundles, readBundles, registryProblems, repoLoadOrder } from '../bundles-def.mjs';

/**
 * PERF_OPTIMIZATION_SRS D-29·D-33: 묶음 정의 `web/bundles.txt` 가 로드 순서의 한 자리다.
 * 형식 규칙은 서버(`rust/crates/webserver/httpapi/src/bundles.rs`)의 `parse_bundles` 와 같고, 한 파일을 두 묶음에
 * 두는 것을 더 막는다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('정의를 읽는다 — 주석·빈 줄은 건너뛰고 .js 와 .css 를 나눈다', () => {
  const b = parseBundles('# 머리\n\n[boot]\n# 맨 앞\njs/core/a.js\nstyle.css\n  js/core/b.js  \n[git]\njs/git/x.js\n');
  assert.deepEqual([...b.keys()], ['boot', 'git']);
  assert.deepEqual(b.get('boot'), { js: ['js/core/a.js', 'js/core/b.js'], css: ['style.css'] });
  assert.deepEqual(b.get('git'), { js: ['js/git/x.js'], css: [] });
});

test('형식이 어긋나면 던진다', () => {
  for (const bad of ['js/a.js\n[boot]\n', '[boot]\n[boot]\n', '[boot]\nREADME\n', '[]\njs/a.js\n']) {
    assert.throws(() => parseBundles(bad), /bundles\.txt/, JSON.stringify(bad));
  }
});

test('같은 파일을 두 묶음에 두면 던진다', () => {
  assert.throws(() => parseBundles('[boot]\njs/a.js\n[git]\njs/a.js\n'), /js\/a\.js/);
});

const DEFS = parseBundles('[pre]\njs/core/p.js\n[boot]\njs/core/a.js\njs/core/b.js\n[git]\njs/git/x.js\n');

test('페이지 순서는 index.html 의 태그 순서이고 b/<이름>.js 는 그 묶음의 파일로 펼친다', () => {
  const html = '<script src="js/core/head.js?v=__ASSETV__"></script>\n<script src="vendor/xterm.js"></script>\n'
    + '<script src="b/pre.js?v=__ASSETV__"></script>\n<script src="js/i18n/ko.js?v=__ASSETV__"></script>\n'
    + '<script src="b/boot.js?v=__ASSETV__"></script>';
  assert.deepEqual(pageScripts(html, DEFS), ['js/core/head.js', 'js/core/p.js', 'js/i18n/ko.js', 'js/core/a.js', 'js/core/b.js']);
});

test('정의에 없는 묶음을 index.html 이 실으면 던진다', () => {
  assert.throws(() => pageScripts('<script src="b/nope.js?v=__ASSETV__"></script>', DEFS), /nope/);
});

test('같은 파일을 태그와 묶음으로 두 번 실으면 던진다', () => {
  assert.throws(() => pageScripts('<script src="js/core/a.js"></script><script src="b/boot.js"></script>', DEFS), /js\/core\/a\.js/);
});

test('로드 순서는 페이지 순서 뒤에 페이지가 싣지 않은 묶음을 정의 순서로 잇는다', () => {
  const html = '<script src="b/pre.js"></script><script src="b/boot.js"></script>';
  assert.deepEqual(loadOrder(html, DEFS), ['js/core/p.js', 'js/core/a.js', 'js/core/b.js', 'js/git/x.js']);
});

test('실제 정의: boot 가 있고 모든 파일이 있으며 index.html 이 그것을 싣는다', () => {
  const defs = readBundles(ROOT);
  assert.ok(defs.has('boot'), 'boot 묶음이 없다');
  for (const [name, { js, css }] of defs) {
    for (const f of [...js, ...css]) assert.ok(existsSync(join(ROOT, 'web', f)), `${name}: ${f} 가 없다`);
  }
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<script src="b\/boot\.js\?v=__ASSETV__"><\/script>/);
  assert.equal(pageScripts(html, defs)[0], 'js/core/server-move.js', 'head 스크립트가 맨 앞이다');
  const body = pageScripts(html.slice(html.indexOf('</head>')), defs);
  assert.equal(body[0], 'js/core/error-log.js', 'error-log.js 가 본문 맨 앞이다 (FR-OBS-18)');
});

test('묶음 CSS 검사: /b/ 아래에서 깨지는 상대 url()·@import 를 잡는다 (perf 3.4.3)', () => {
  assert.deepEqual(cssProblems('.a{background:url(data:image/png;base64,AA)}'), []);
  assert.deepEqual(cssProblems('.a{background:url("assets/x.png")}'), ['url("assets/x.png")']);
  assert.deepEqual(cssProblems("@import 'x.css';\n.a{}"), ['@import']);
  assert.deepEqual(cssProblems('.a{background:url(/assets/x.png)}'), [], '절대 경로는 /b/ 와 무관하다');
});

test('등록부 검사: Screens.register 의 묶음과 css 표시가 정의와 맞는다 (perf 3.4.3)', () => {
  const defs = parseBundles('[git]\njs/g.js\nstyle-g.css\n[plain]\njs/p.js\n');
  assert.deepEqual(registryProblems("Screens.register('git',{css:true,tab:(at)=>x})", defs), []);
  assert.deepEqual(registryProblems("Screens.register('p',{bundle:'plain'})", defs), []);
  assert.equal(registryProblems("Screens.register('git',{tab:(at)=>x})", defs).length, 1, 'css 줄이 있는데 css 표시가 없다');
  assert.equal(registryProblems("Screens.register('p',{bundle:'plain',css:true})", defs).length, 1, 'css 줄이 없는데 css 표시가 있다');
  assert.equal(registryProblems("Screens.register('nope',{})", defs).length, 1, '정의에 없는 묶음');
});

test('실제 정의: 묶음 CSS 와 등록부가 검사를 지난다', () => {
  const defs = readBundles(ROOT);
  for (const [, { css }] of defs) {
    for (const f of css) assert.deepEqual(cssProblems(readFileSync(join(ROOT, 'web', f), 'utf8')), [], f);
  }
  const js = repoLoadOrder(ROOT).map((f) => readFileSync(join(ROOT, 'web', f), 'utf8')).join('\n');
  assert.deepEqual(registryProblems(js, defs), []);
});
