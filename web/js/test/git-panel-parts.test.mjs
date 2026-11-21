import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, GITPANEL, load } from './harness.mjs';

/**
 * REFACTOR3_FE_GITPANEL_SRS — Git 패널 mixin 을 부품 클래스로.
 *   TC-FEP-1 부품 계층·패널이 드는 부품·위임자 · TC-FEP-2 옮긴 mixin 이 없고 `Object.assign` 이 준다
 *   TC-FEP-3 부품 소유 필드가 패널에 없다
 *
 * 하위 단계마다 `PARTS` 에 한 줄을 더한다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = join(JS, 'git');
const read = (f) => readFileSync(join(JS, f), 'utf8');

/**
 * field: 패널이 드는 이름 · cls: 부품 클래스 · gone: 사라진 mixin · owned: 부품 소유 필드
 * exposed: e2e 가 읽어 패널에 접근자를 둔 소유 필드(FR-FEP-5) · delegates: 패널 위임자와 그 시험 인자
 */
const PARTS = [
  { field: 'blame', cls: 'GitBlame', gone: ['git/panel-blame.js'],
    owned: ['_blameKey', '_blameData', '_blameErr', '_blameAll'],
    delegates: [['openBlame', [{ path: 'a.txt', group: 'working' }]], ['blameStale', []], ['_paintBlame', [{ id: 'el' }]]] },
  { field: 'hunks', cls: 'GitHunks', gone: ['git/panel-hunks.js'],
    owned: ['_hunkBarEd', '_hunkBarEl', '_hunkBarPos', '_hunkBarHunk', '_hunkBarFocus', '_hunkBarOff', '_hunkErr', '_hunkErrKey'],
    exposed: ['_hunkBarEd', '_hunkBarPos'],
    delegates: [['_paintHunks', [{ id: 'el' }, { path: 'a.txt' }]], ['_hunkText', []], ['_hunkNote', [{ id: 'note' }, 'text']],
      ['_hunkBarWire', [{ id: 'ed' }]], ['_hunkBarDispose', []], ['_hunkBarHide', []], ['_hunkBarPaint', []],
      ['_hunkAct', ['stage']], ['_diffChanged', []]] },
];

/** 생성자 밖 참조가 없어 지운 필드 (FR-FEP-6). */
const DEAD = ['_hunkBarWidget', '_hunkBarSubs'];

/** 하위 단계가 끝난 뒤 남는 `Object.assign(GitPanel.prototype` 의 수 (TC-FEP-2). 처음은 12 다. */
const ASSIGNS_LEFT = 10;

function setup() {
  const ctx = load([...BASE, ...GITPANEL], {
    expose: ['GitPanel', 'GitPart', 'Component', ...PARTS.map((s) => s.cls)],
    globals: { TIMERS: { disposeOwner() {} } },
  });
  const obs = { attach() {}, detach() {}, resettle() {} };
  const app = { gitObs: () => obs, timers: { disposeOwner() {} } };
  return { ctx, app, panel: new ctx.GitPanel(app, '') };
}

test('TC-FEP-1 부품은 GitPart·Component 하위이고 패널이 든다', () => {
  const { ctx, app, panel } = setup();
  assert.ok(ctx.GitPart.prototype instanceof ctx.Component);
  for (const s of PARTS) {
    const part = panel[s.field];
    assert.ok(part instanceof ctx[s.cls], `${s.field} 가 ${s.cls} 가 아니다`);
    assert.ok(part instanceof ctx.GitPart, `${s.cls} 가 GitPart 하위가 아니다`);
    assert.equal(part.p, panel);
    assert.equal(part.app, app);
  }
});

test('TC-FEP-1 위임자는 부품 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const { panel } = setup();
  for (const s of PARTS) {
    for (const [name, args] of s.delegates) {
      const got = [];
      const ret = { from: name };
      panel[s.field][name] = (...a) => { got.push(a); return ret };
      assert.ok(Object.hasOwn(Object.getPrototypeOf(panel), name), `${name} 위임자가 패널 원형에 없다`);
      assert.equal(panel[name](...args), ret, `${name} 이 부품의 값을 돌려주지 않는다`);
      assert.equal(got.length, 1, `${name} 이 부품을 부르지 않는다`);
      assert.deepEqual(got[0], args);
    }
  }
});

test('TC-FEP-1 패널 destroy 가 부품을 해제한다 (FR-FEP-1)', () => {
  const { panel } = setup();
  panel.detach = () => {};
  panel.destroy();
  for (const s of PARTS) assert.equal(panel[s.field].disposed, true, `${s.field} 가 해제되지 않았다`);
});

test('TC-FEP-2 옮긴 mixin 파일이 없고 Object.assign(GitPanel.prototype 이 준다', () => {
  for (const s of PARTS) for (const f of s.gone) assert.ok(!existsSync(join(JS, f)), `${f} 가 남았다`);
  let n = 0;
  for (const f of readdirSync(GIT)) n += (readFileSync(join(GIT, f), 'utf8').match(/^Object\.assign\(GitPanel\.prototype/gm) || []).length;
  assert.equal(n, ASSIGNS_LEFT);
  const html = read('../index.html');
  const order = [...html.matchAll(/<script src="js\/(git\/(?:git-part|git-[a-z-]+|panel[a-z-]*)\.js)/g)]
    .map((m) => m[1]).filter((f) => GITPANEL.includes(f));
  assert.deepEqual(order, GITPANEL, 'index.html 의 순서가 하네스 묶음과 다르다');
});

test('TC-FEP-3 부품 소유 필드가 패널 원형·생성자에 없고 패널 쪽 파일이 읽지 않는다', () => {
  const { panel } = setup();
  const proto = Object.getPrototypeOf(panel);
  const panelSrc = readdirSync(GIT).filter((f) => /^panel/.test(f)).map((f) => [f, readFileSync(join(GIT, f), 'utf8')]);
  for (const s of PARTS) {
    const exposed = s.exposed || [];
    for (const k of s.owned) {
      assert.ok(!Object.hasOwn(panel, k), `${k} 가 패널 생성자에 있다`);
      for (const [f, src] of panelSrc) assert.ok(!src.includes('this.' + k), `${f} 가 ${k} 를 읽는다`);
      if (!exposed.includes(k)) { assert.ok(!(k in proto), `${k} 가 패널 원형에 있다`); continue }
      const d = Object.getOwnPropertyDescriptor(proto, k);
      assert.ok(d && d.get && !d.set, `${k} 는 패널의 읽기 접근자여야 한다`);
      const v = { mark: k };
      panel[s.field][k] = v;
      assert.equal(panel[k], v, `${k} 접근자가 부품의 값을 읽지 않는다`);
    }
  }
  const all = readdirSync(GIT).map((f) => readFileSync(join(GIT, f), 'utf8')).join('\n');
  for (const k of DEAD) {
    assert.ok(!Object.hasOwn(panel, k), `죽은 필드 ${k} 가 남았다`);
    assert.ok(!all.includes(k), `죽은 필드 ${k} 가 소스에 남았다`);
  }
});
