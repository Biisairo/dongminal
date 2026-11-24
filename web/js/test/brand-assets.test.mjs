import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * OTTERMINAL_RENAME_SRS FR-AST-1~4 — 수달 브랜드 에셋의 저장과 배치.
 */

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const BRAND = 'web/assets/brand/';
const ALL = ['otter-01', 'otter-02', 'otter-04', 'otter-10', 'otter-13', 'otter-14', 'otter-14-green',
  'otter-14-orange', 'otter-14-red', 'otter-14-yellow', 'otter-15', 'otter-16', 'otter-face'];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(rel) {
  const b = readFileSync(join(REPO, rel));
  assert.ok(b.subarray(0, 8).equals(PNG_SIG), rel + ' 은 PNG 가 아니다');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('FR-AST-1: SVG 13개가 원본 그대로 저장되어 있다', () => {
  for (const n of ALL) assert.ok(read(BRAND + n + '.svg').startsWith('<svg'), n);
});

test('FR-AST-2: 파비콘 SVG 는 otter-15 다', () => {
  const html = read('web/index.html');
  assert.match(html, /<link rel="icon" href="assets\/brand\/otter-15\.svg" type="image\/svg\+xml">/);
});

test('FR-AST-2·3: PNG 아이콘은 크기가 맞고 index.html·manifest 가 가리킨다', () => {
  const html = read('web/index.html');
  const want = [['web/assets/favicon-16.png', 16], ['web/assets/favicon-32.png', 32],
    ['web/assets/apple-touch-icon.png', 180], ['web/assets/icon-192.png', 192], ['web/assets/icon-512.png', 512]];
  for (const [rel, px] of want) assert.deepEqual(pngSize(rel), [px, px], rel);
  assert.match(html, /href="assets\/favicon-32\.png"/);
  assert.match(html, /href="assets\/favicon-16\.png"/);
  assert.match(html, /rel="apple-touch-icon" href="assets\/apple-touch-icon\.png"/);
  const mf = JSON.parse(read('web/manifest.webmanifest'));
  assert.deepEqual(mf.icons.map((i) => i.src).sort(), ['assets/icon-192.png', 'assets/icon-512.png']);
  assert.equal(mf.name, 'otterminal');
});

test('FR-AST-3: PNG 를 다시 만드는 스크립트가 원본 SVG 를 가리킨다', () => {
  const s = read('scripts/gen-brand-icons.mjs');
  assert.match(s, /otter-01\.svg/);
  assert.match(s, /otter-15\.svg/);
});

test('FR-AST-2: 옛 파비콘 SVG 는 남지 않는다', () => {
  assert.ok(!existsSync(join(REPO, 'web/assets/favicon.svg')));
});

test('FR-AST-2: 부팅 로고는 otter-04 다', () => {
  const html = read('web/index.html');
  assert.match(html, /<img class="boot-logo" src="assets\/brand\/otter-04\.svg"/);
});

test('FR-AST-2: 접근 거부 페이지 로고는 otter-10 이다', () => {
  const head = read('rust/crates/webserver/httpapi/src/denied_head.html');
  assert.match(head, /id="otter10-/);
});

test('FR-AST-2: README 맨 위 배너는 otter-02 다', () => {
  const first = read('README.md').split('\n').find((l) => l.trim() !== '');
  assert.match(first, /web\/assets\/brand\/otter-02\.svg/);
});
