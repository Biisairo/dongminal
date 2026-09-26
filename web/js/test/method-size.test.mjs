import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-22 · FEC-23 · FEC-34): 거대 메서드를 나눈 뒤
 * 다시 불지 않게 한다. 재는 것은 **주석과 빈 줄을 뺀 코드 줄**이다 — 이 저장소의 주석은
 * 결정 기록이라 길이를 재면 기록을 지우라는 압력이 된다.
 *
 * 나누기 전 → 뒤 (2026-09-26, 코드 줄): addTab 106→6 · closeTab 82→37 · save 78→43 ·
 * init 68→29 · _execRemote 116→8 · initMobileKeybar 144→14.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX = 50;

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function methodLines(file, head) {
  const src = readFileSync(join(JS, file), 'utf8');
  const i = src.indexOf(head);
  assert.ok(i >= 0, file + ': ' + head.trim() + ' 가 있다');
  const indent = /^( *)/.exec(src.slice(src.lastIndexOf('\n', i) + 1))[1];
  const end = src.indexOf('\n' + indent + '}', i);
  const body = strip(src.slice(i, end));
  return body.split('\n').filter((l) => l.trim()).length;
}

const CASES = [
  ['core/app-layout.js', '  async addTab('],
  ['core/app-layout.js', '  async closeTab('],
  ['core/app.js', '  save(){'],
  ['core/app.js', '  async init(){'],
  ['core/app-cmd.js', '  _execRemote(action, args){'],
  ['core/app-mobile.js', '  initMobileKeybar('],
];

for (const [file, head] of CASES) {
  test(file + ' ' + head.trim() + ' 는 코드 ' + MAX + '줄 이하다', () => {
    const n = methodLines(file, head);
    assert.ok(n <= MAX, head.trim() + ' 가 ' + n + '줄이다');
  });
}
