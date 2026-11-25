import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SRS, bootBytes, bootScripts, locales, srsLimit } from '../check-boot-bytes.mjs';
import { concatJs, stripComments } from '../js-strip.mjs';

/**
 * PERF NFR-PRF-12·D-48 (3.4.12.11): 데스크톱 기본 부팅 JS 가 SRS 상한을 넘으면 게이트가 실패한다.
 * 바이트는 서버 묶음 규칙(js_strip·concat)을 옮긴 모형으로 잰다 — 바이너리 없이 결정적이다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(ROOT, 'scripts', 'check-boot-bytes.mjs');
const s = (src) => stripComments(Buffer.from(src)).toString();

test('주석 걷기는 서버 js_strip 과 같다 — 주석·줄 끝 공백만 걷고 줄 수는 그대로', () => {
  assert.equal(s('a = 1; // 끝\nb = 2;\n'), 'a = 1;\nb = 2;\n');
  assert.equal(s('/**\n * 설명\n */\nfunction f() {}\n'), '\n\n\nfunction f() {}\n');
  assert.equal(s('return/**/x;\n'), 'return x;\n');
  assert.equal(s('f(a /* 첫 */, b);\n'), 'f(a , b);\n');
  assert.equal(s('a();  \r\nb();\r\n'), 'a();\r\nb();\r\n');
  const license = '/*! (c) 누군가 | BSD */\nvar x = 1;\n';
  assert.equal(s(license), license);
});

test('문자열·정규식·템플릿 안은 그대로이고 나눗셈은 정규식이 아니다', () => {
  for (const src of ["var a = '// 아님', b = \"/* 아님 */\";\n", 'var r = /[/*]+/;\n', 'return /a\\/b/.source;\n', 'var t = `a // 아님  \n  /* 아님 */  \n`;\n']) {
    assert.equal(s(src), src);
  }
  assert.equal(s('x = f(a) / 2 /* 반 */;\n'), 'x = f(a) / 2 ;\n');
  assert.equal(s('var t = `x${a /* 걷음 */ + `y${ {k: 1}.k // 걷음\n}` }// 아님 ${\'/*\'}`;\n'), "var t = `x${a  + `y${ {k: 1}.k\n}` }// 아님 ${'/*'}`;\n");
  for (const src of ["'abc\\", '/[a', '`x${', '/* 끝없음']) stripComments(Buffer.from(src));
});

test('묶음은 경계 줄 + 걷은 본문, 끝은 소스맵 줄이다', () => {
  const bundle = 'boot';
  const got = concatJs(bundle, [{ path: 'js/b.js', src: Buffer.from('B') }, { path: 'js/a.js', src: Buffer.from('A1 // x\nA2\n') }]);
  assert.equal(got.toString(), `/* ==== js/b.js ==== */\nB\n/* ==== js/a.js ==== */\nA1\nA2\n//# sourceMappingURL=${bundle}.js.map\n`);
});

test('상한은 SRS 의 NFR-PRF-12 행에서 읽는다', () => {
  assert.equal(srsLimit('| NFR-PRF-11 | 부팅 요청 | 338 | 80 이하 |\n| NFR-PRF-12 | 부팅 JS (압축 전) | 3.8 MB | 1.15 MB(1,150,000 B) 이하 (D-48) |\n'), 1150000);
  assert.throws(() => srsLimit('| NFR-PRF-12 | 부팅 JS | 3.8 MB | 작게 |\n'), /NFR-PRF-12/);
  assert.throws(() => srsLimit('표 없음\n'), /NFR-PRF-12/);
});

const HTML = [
  '<script src="js/core/head.js?v=__ASSETV__"></script>',
  '<script>try{var w=1}catch(e){}</script>',
  '<script src="vendor/x.js"></script>',
  `<script>if(!(window.matchMedia&&matchMedia('(pointer: coarse)').matches)){var webglSrc='vendor/gl.js';document.write('<script src="'+webglSrc+'"><\\/script>')}</script>`,
  '<script src="b/pre.js?v=__ASSETV__"></script>',
  `<script>var i18nSrc='js/i18n/'+I18N.locale+'.js?v=__ASSETV__';document.write('<script src="'+i18nSrc+'"><\\/script>')</script>`,
  '<script src="b/boot.js?v=__ASSETV__"></script>',
  `<script>if(/[?&]diag=1(&|$)/.test(location.search)){var diagSrc='b/diag.js?v=__ASSETV__';document.write('<script src="'+diagSrc+'"><\\/script>')}</script>`,
].join('\n');

test('데스크톱 기본 부팅: WebGL·활성 로케일 파일은 싣고 diag 는 싣지 않는다', () => {
  assert.deepEqual(bootScripts(HTML, 'en'), ['js/core/head.js', 'vendor/x.js', 'vendor/gl.js', 'b/pre.js', 'js/i18n/en.js', 'b/boot.js']);
});

test('모르는 인라인 로더는 실패한다', () => {
  const html = `<script>var fooSrc='vendor/foo.js';document.write('<script src="'+fooSrc+'"><\\/script>')</script>`;
  assert.throws(() => bootScripts(html, 'ko'), /fooSrc/);
});

function fixture(limit, files) {
  const root = mkdtempSync(join(tmpdir(), 'bootb-'));
  const all = { [SRS]: `| NFR-PRF-12 | 부팅 JS | 3.8 MB | 상한(${limit.toLocaleString('en-US')} B) 이하 |\n`, ...files };
  for (const [name, src] of Object.entries(all)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), src);
  }
  return root;
}
const gate = (root) => {
  try {
    return { code: 0, out: execFileSync('node', [GATE, root], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout + e.stderr };
  }
};

test('게이트: 로케일마다 더해 상한을 넘으면 실패, 같으면 통과', () => {
  const files = {
    'web/index.html': '<script src="vendor/v.js"></script>\n<script src="b/boot.js"></script>\n'
      + `<script>var i18nSrc='js/i18n/'+I18N.locale+'.js';document.write('<script src="'+i18nSrc+'"><\\/script>')</script>`,
    'web/bundles.txt': '[boot]\njs/a.js\n',
    'web/js/a.js': 'A // 걷음\n',
    'web/vendor/v.js': 'VVVV',
    'web/js/i18n/ko.js': 'KKKKKK',
    'web/js/i18n/en.js': 'EE',
    'web/js/i18n/git.ko.js': '조각은 부팅이 아니다',
  };
  const boot = concatJs('boot', [{ path: 'js/a.js', src: Buffer.from('A // 걷음\n') }]).length;
  const ko = 4 + boot + 6;
  assert.equal(gate(fixture(ko, files)).code, 0);
  const r = gate(fixture(ko - 1, files));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ 부팅 JS\(ko/);
  assert.match(r.out, /✓ 부팅 JS\(en/);
});

test('실제 트리: 로케일 파일은 조각을 빼고 모두 잰다', () => {
  const got = locales(ROOT);
  assert.ok(got.includes('ko') && got.includes('en'), got.join(','));
  assert.ok(got.every((l) => !l.includes('.')));
});

test('실제 트리: 데스크톱 기본 부팅 JS 가 NFR-PRF-12 상한 이하다(1 B 낮추면 실패)', () => {
  const limit = srsLimit(readFileSync(join(ROOT, SRS), 'utf8'));
  const max = Math.max(...locales(ROOT).map((l) => bootBytes(ROOT, l).reduce((a, f) => a + f.bytes, 0)));
  assert.ok(max <= limit, `부팅 JS ${max} B > 상한 ${limit} B — 부팅 범위를 다시 보거나(M3_BOOT_SCOPE) 사용자 결정으로 상한을 고친다`);
  const root = mkdtempSync(join(tmpdir(), 'bootb-real-'));
  symlinkSync(join(ROOT, 'web'), join(root, 'web'));
  mkdirSync(join(root, dirname(SRS)), { recursive: true });
  writeFileSync(join(root, SRS), `| NFR-PRF-12 | 부팅 JS | 3.8 MB | 상한(${(max - 1).toLocaleString('en-US')} B) 이하 |\n`);
  assert.equal(gate(root).code, 1);
});
