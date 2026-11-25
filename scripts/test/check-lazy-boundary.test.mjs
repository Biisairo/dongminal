import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** PERF M3 §3.4 (3.4.4): 부팅 묶음이 화면 묶음의 전역을 진입점 밖에서 읽으면 경계 게이트가 실패한다. */
const SCRIPT = new URL('../check-lazy-boundary.mjs', import.meta.url).pathname;

const HTML = '<script src="b/boot.js?v=__ASSETV__"></script>\n';
const DEFS = '[boot]\njs/boot-a.js\n\n[git]\njs/git-a.js\n';
const SCREEN = [
  "const GIT_LABEL = 'git';",
  'class GitPanel { constructor(){ this.l = GIT_LABEL } }',
  'function gitHelper(){ return new GitPanel() }',
].join('\n');

function run(boot, entries = '') {
  const root = mkdtempSync(join(tmpdir(), 'lazyb-'));
  const files = {
    'web/index.html': HTML,
    'web/bundles.txt': DEFS,
    'web/js/git-a.js': SCREEN,
    'web/js/boot-a.js': boot,
    'scripts/lazy-entries.txt': entries,
  };
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), src);
  }
  return exec([root]);
}

function exec(args) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stderr) };
  }
}

test('지금 트리(화면 묶음이 비어 있음)는 통과한다', () => {
  const r = exec([]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /lazy-boundary ok/);
});

test('부팅 파일이 화면 묶음의 const 를 로드 시점에 읽으면 실패한다', () => {
  const r = run("const LABEL = GIT_LABEL + '!';\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /js\/boot-a\.js:1 {2}GIT_LABEL ← \[git\] js\/git-a\.js/);
});

test('진입점 밖 함수에서 화면 클래스를 new 하면 실패한다', () => {
  const r = run('function open(){\n  return new GitPanel();\n}\n');
  assert.equal(r.code, 1);
  assert.match(r.out, /js\/boot-a\.js:2 {2}GitPanel/);
});

test('await Screens.load 뒤의 참조는 지나고, 그 앞의 참조는 잡는다', () => {
  const ok = run([
    'async function open(){',
    "  await Screens.load('git');",
    '  const p = new GitPanel();',
    '  return () => gitHelper(p);',
    '}',
  ].join('\n'));
  assert.equal(ok.code, 0, ok.out);

  const bad = run([
    'async function open(){',
    '  const p = new GitPanel();',
    "  await Screens.load('git');",
    '  return p;',
    '}',
  ].join('\n'));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /js\/boot-a\.js:2 {2}GitPanel/);
});

test('허용 목록의 진입점(Screens 를 묻는 함수)은 통과한다', () => {
  const boot = [
    'class Renderer {',
    '  _mount(){',
    "    if (!Screens.ready('git')) return null;",
    '    return new GitPanel();',
    '  }',
    '}',
  ].join('\n');
  assert.equal(run(boot).code, 1);
  const r = run(boot, '# 진입점\njs/boot-a.js Renderer._mount\n');
  assert.equal(r.code, 0, r.out);
});

test('Object.assign(X.prototype, {…}) 로 얹은 메서드는 X.prototype.m 으로 적는다', () => {
  const boot = [
    'function Renderer(){}',
    'Object.assign(Renderer.prototype, {',
    '  _mount(at){',
    "    if (!Screens.ready('git')) return null;",
    '    return new GitPanel();',
    '  },',
    '});',
  ].join('\n');
  assert.equal(run(boot).code, 1);
  const r = run(boot, 'js/boot-a.js Renderer.prototype._mount\n');
  assert.equal(r.code, 0, r.out);
});

test('허용 목록이 없는 함수나 Screens 를 묻지 않는 함수를 가리키면 실패한다', () => {
  const stale = run('function f(){}\n', 'js/boot-a.js Renderer._gone\n');
  assert.equal(stale.code, 1);
  assert.match(stale.out, /Renderer\._gone/);

  const noAsk = run('function f(){ return new GitPanel() }\n', 'js/boot-a.js f\n');
  assert.equal(noAsk.code, 1);
  assert.match(noAsk.out, /js\/boot-a\.js f .*Screens/);
});

test('같은 이름의 지역 변수·typeof·속성 이름은 참조로 보지 않는다', () => {
  const r = run([
    'function f(GitPanel){ return GitPanel }',
    'function g(){ const GIT_LABEL = 1; return GIT_LABEL }',
    "const has = typeof GitPanel !== 'undefined';",
    'const o = { gitHelper: 1 }; o.gitHelper;',
  ].join('\n'));
  assert.equal(r.code, 0, r.out);
});
