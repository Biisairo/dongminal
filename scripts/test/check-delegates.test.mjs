import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** REFACTOR3_FE_DELEG_SRS TC-DLG-4: 위임자 게이트가 표·같은 이름 전달을 잡고 예외 표의 이름은 지난다. */
const SCRIPT = new URL('../check-delegates.mjs', import.meta.url).pathname;

function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'deleg-'));
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), src);
  }
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stderr) };
  }
}

test('TC-DLG-4: Controller.delegate 호출을 잡는다', () => {
  const r = run({ 'a.js': "class A {}\nController.delegate(A,'x',['f']);\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /a\.js:2: Controller\.delegate\(/);
});

test('TC-DLG-4: 같은 이름을 같은 인자로 넘기기만 하는 메서드(정적 포함)를 잡는다', () => {
  const r = run({
    'p.js': [
      'class P {',
      '  f(a,b){ return this.part.f(a,b) }',
      '  g(...x){ this.part.g(...x) }',
      '  static h(o){ return Q.h(o) }',
      '}',
    ].join('\n'),
  });
  assert.equal(r.code, 1);
  for (const n of ['P.f', 'P.g', 'P.h']) assert.match(r.out, new RegExp(n.replace('.', '\\.') + ' —'), n);
});

test('TC-DLG-4: 이름이 다르거나 인자가 다르거나 몸이 둘 이상이거나 접근자면 지난다', () => {
  const r = run({
    'ok.js': [
      'class P {',
      '  f(a){ return this.part.g(a) }',
      '  h(a){ return this.part.h(a,1) }',
      '  k(a){ this.x=1; return this.part.k(a) }',
      '  get m(){ return this.store.m }',
      '  n(){ return this.part().n() }',
      '}',
    ].join('\n'),
    'test/skip.js': "Controller.delegate(A,'x',['f']);\n",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /delegates ok/);
});

test('TC-DLG-4: 예외 표의 이름은 지난다', () => {
  const r = run({ 'fe.js': 'class FileEditor {\n  note(t){ return this.notice.note(t) }\n}\n' });
  assert.equal(r.code, 0, r.out);
});

test('TC-DLG-4: 기준선이 없다 — 걷기를 마친 주인의 위임자 표도 하나부터 잡는다', () => {
  const r = run({ 'ft.js': "Controller.delegate(FileTree,'p',['f']);\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /ft\.js:1: Controller\.delegate\(/);
});
