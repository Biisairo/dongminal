import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/git/modal-base.js` · `panel-views.js` — Git 모달 골격과 목록 뷰 서술자
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-12-2 · FEU-12 · FEU-13).
 *
 * 재는 것: ① `GitConfirm`·`GitDialog` 가 생명주기·실행 상태기계를 한 벌(`GitModalBase`)에서
 * 받는다 ② 실행 상태기계의 계약 — 성공이면 닫고, 실패·예외면 사유를 남긴 채 열어 둔다
 * ③ 목록 뷰 여섯이 서술자 한 표에서 서고 그 키가 `GIT_VIEWS` 의 필드 표와 같다.
 */
function modals() {
  return load(['git/modal-base.js', 'git/confirm.js', 'git/dialog.js'], {
    expose: ['GitModalBase', 'GitConfirm', 'GitDialog'],
    globals: { GIT_CONFIRM_FAIL: 'failed' },
  });
}

test('두 모달이 골격을 한 벌에서 받는다 — 자기 사본을 갖지 않는다', () => {
  const ctx = modals();
  for (const C of [ctx.GitConfirm, ctx.GitDialog]) {
    assert.ok(C.prototype instanceof ctx.GitModalBase, C.name);
    for (const m of ['_show', '_close', '_front', '_copy', '_exec', '_paintErr', '_paintActions', '_paintChanged']) {
      assert.ok(!Object.hasOwn(C.prototype, m), `${C.name} 가 ${m} 를 따로 갖는다`);
    }
  }
});

function probe(ctx, run) {
  const m = new ctx.GitModalBase();
  m.log = [];
  m._paint = () => m.log.push('paint:' + (m.busy ? 'busy' : 'idle'));
  m._focus = () => m.log.push('focus');
  m._close = (v) => m.log.push('close:' + v);
  return { m, go: () => m._exec(run) };
}

test('실행이 성공하면 닫는다', async () => {
  const { m, go } = probe(modals(), async () => ({ ok: true }));
  await go();
  assert.deepEqual(m.log, ['paint:busy', 'close:true']);
  assert.equal(m.busy, false);
});

test('실행이 실패하면 사유와 tail 을 남기고 열어 둔다', async () => {
  const { m, go } = probe(modals(), async () => ({ ok: false, reason: 'r', stderrTail: 't' }));
  await go();
  assert.deepEqual({ ...m.err }, { reason: 'r', tail: 't' });
  assert.deepEqual(m.log, ['paint:busy', 'paint:idle', 'focus']);
});

test('실행이 던지면(동기·비동기) 그 사유가 실패로 실린다', async () => {
  for (const run of [() => { throw new Error('boom') }, async () => { throw new Error('boom') }]) {
    const { m, go } = probe(modals(), run);
    await go();
    assert.match(m.err.reason, /boom/);
    assert.equal(m.busy, false);
  }
});

test('사유 없는 실패는 기본 문구다', async () => {
  const { m, go } = probe(modals(), async () => null);
  await go();
  assert.equal(m.err.reason, 'failed');
  assert.equal(m.err.tail, '');
});

test('목록 뷰 여섯은 서술자 한 표에서 선다 — 키가 GIT_VIEWS 의 필드 표와 같다', () => {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants-git.js', 'git/panel-views.js'], {
    expose: ['GIT_VIEW_KINDS', 'GIT_VIEW_FIELD_BY_KEY'],
    globals: { GitPanel: function GitPanel() {} },
  });
  assert.deepEqual(Object.keys(ctx.GIT_VIEW_KINDS).sort(), Object.keys(ctx.GIT_VIEW_FIELD_BY_KEY).sort());
  const proto = ctx.GitPanel.prototype;
  for (const k of ['History', 'Branches', 'Console', 'Worktrees', 'Submodules', 'Stash']) {
    assert.ok(!('_render' + k in proto), `_render${k} 가 남았다`);
  }
  assert.equal(typeof proto._renderView, 'function');
});
