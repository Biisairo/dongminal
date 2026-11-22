import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load, treeParts } from './harness.mjs';

/**
 * REFACTOR3_FE_REST5_SRS TC-FR5-30: FileTree 의 바깥 표면을 고정한다 — 원형에는 생성자·접근자·마운트·파괴만 남고, 정적 이름도
 * 그대로다.
 *
 * REFACTOR3_FE_DELEG_SRS TC-DLG-1·2: 부품의 이름은 부품 원형에 있고 탐색기 원형에는 없다. 앱·렌더러·e2e 는 `tree.loader.load`
 * 처럼 부품을 부르고, 시험은 부품 인스턴스의 메서드를 갈아 끼운다(`t.loader._rollup`·`t.xfer._after` 등) — 부품끼리의 호출
 * (`this.tree.<부품>.X`)과 부품 안의 호출(`this.X`)이 그것을 본다.
 */
// REFACTOR3_FE_REST5_SRS R5d: `file-tree-paint.js` 에서 부품 둘(`file-tree-load.js`·`file-tree-select.js`)이 갈라졌다.
const FILES = ['ui/file-tree-obs.js', 'ui/file-tree-store.js', 'ui/file-tree.js', 'ui/file-tree-load.js', 'ui/file-tree-select.js',
  'ui/file-tree-paint.js', 'ui/file-tree-keys.js', 'ui/file-tree-marquee.js', 'ui/file-tree-edit.js', 'ui/file-tree-xfer.js',
  'ui/file-tree-download.js'];

const PROTO = [
  '_buildDom:function', '_busy:get', '_dirOwn:getset', '_dirSt:getset', '_gitBusy:getset', '_gitOff:getset', '_gitOn:getset',
  '_gitRetryAt:getset', '_head:function', '_headBtn:function', '_ign:get', '_ignOff:getset', '_join:function', '_kids:getset',
  '_paintAll:function', '_partial:getset', '_rel:function', '_repoPrefix:getset', '_restoreEditFocus:function',
  '_restoreOwnFocus:function', '_st:getset', '_stampBusy:getset', '_stampOff:getset', 'destroy:function', 'mount:function',
];

const STATICS = ['_asUploadItems:function', '_dropEntries:function', '_isFileDrag:function', '_seq:number', '_walkEntry:function'];

/** 탐색기 필드 → 그 부품이 가진 이름. 탐색기 원형에는 없다 (REFACTOR3_FE_DELEG_SRS DL-7). */
const PARTS = {
  loader: ['load', '_loadOnce', 'loadIgnored', '_isIgnored', 'reload', 'refresh', 'pollStamp', 'pollGit', 'paintGitCached', 'gitDue',
    '_applyGit', '_gitBack', '_prefixOf', '_setStatus', '_stKey', '_rollup', '_isPartial', '_stOf', '_inherit'],
  selector: ['revealPath', 'toggle', '_selOnly', '_selToggle', '_selRange', '_selAll', '_selMarquee', '_selHas', '_selTargets',
    '_selOrdered', '_selectRoot', '_onClick', '_moveSel', '_onDbl'],
  edits: ['startCreate', 'startRename', 'cancelEdit', '_commitEdit', '_askName', '_nameReset', '_showNameWhy', '_snap', '_restore',
    '_optimAdd', '_optimDel', '_optimMove', '_rekey', '_rekeyView', '_forget', '_forgetView', 'doCreate', 'doRename', 'doDelete',
    '_recoverable', '_repoRel', 'doPasteInto', 'doDuplicate', 'doMoveMany', '_retargetOrFail'],
  painter: ['_items', 'paint', '_rowId', '_focusInput', '_pad', '_el', '_elInput', '_base', '_parent', '_kindOf', '_targetDir', '_fail',
    '_clearErr'],
  xfer: ['doUpload', '_uploadOne', '_askUploadFailure', 'pickUpload', '_after', '_onCtx', 'copyPath', '_initDnd', '_dropUpload',
    '_dropDirAt', '_markDrop', '_dropClear', '_springSchedule', '_springCancel'],
  dl: ['download', 'downloadMany', '_dlOf', '_dragDownloadURL'],
  keys: ['_onKey'],
  marquee: ['_initMarquee', '_mqDown', '_mqY', '_mqMove', '_mqPaint', '_mqScroll'],
};

function surface(files) {
  const ctx = load([...BASE, ...files], { expose: ['FileTree', 'FileTreeStore'] });
  const kind = (d) => (d.get || d.set ? (d.get ? 'get' : '') + (d.set ? 'set' : '') : typeof d.value);
  const P = ctx.FileTree.prototype;
  return {
    ctx,
    proto: Object.getOwnPropertyNames(P).filter((n) => n !== 'constructor').sort().map((n) => n + ':' + kind(Object.getOwnPropertyDescriptor(P, n))),
    statics: Object.getOwnPropertyNames(ctx.FileTree).filter((n) => !['length', 'name', 'prototype'].includes(n)).sort()
      .map((n) => n + ':' + typeof ctx.FileTree[n]),
  };
}

/** 부품을 세운 탐색기 대역 — `FileTree` 생성자의 DOM 세우기 없이 부품만 둔다. */
function tree() {
  const { ctx } = surface(FILES);
  const t = treeParts(ctx, Object.create(ctx.FileTree.prototype));
  return { ctx, t };
}

const calls = (o, name) => {
  const seen = [];
  o[name] = (...a) => { seen.push(a) };
  return seen;
};

// `_buildDom` 은 R5d 가 더한 이름이다 — 생성자의 요소 세우기를 뺐다(FileTree constructor 104줄 → 100 아래, FR-FR5-15).
test('TC-FR5-30: FileTree 원형의 이름과 종류가 그대로다', () => {
  assert.deepEqual(surface(FILES).proto, PROTO);
});

test('TC-FR5-30: FileTree 의 정적 이름이 그대로다', () => {
  assert.deepEqual(surface(FILES).statics, STATICS);
});

test('TC-DLG-1: 부품의 이름은 부품 원형에 있고 탐색기 원형에는 없다', () => {
  const { ctx, t } = tree();
  let n = 0;
  for (const [part, names] of Object.entries(PARTS)) {
    for (const name of names) {
      assert.equal(typeof Object.getPrototypeOf(t[part])[name], 'function', part + '.' + name);
      assert.ok(!(name in ctx.FileTree.prototype), '위임자가 남았다: ' + name);
      n++;
    }
  }
  assert.equal(n, 96);
});

test('TC-DLG-2: 부품 안의 호출은 그 부품 인스턴스에 갈아 끼운 것을 본다', () => {
  const { t } = tree();
  const seen = calls(t.dl, 'downloadMany');
  t.dl.download('/r/a');
  assert.equal(JSON.stringify(seen), '[[["/r/a"]]]');
});

test('TC-DLG-2: 부품 사이의 호출은 다른 부품 인스턴스에 갈아 끼운 것을 본다', () => {
  const { t } = tree();
  Object.assign(t, { root: '/r', _sel: '/r/a', _selSet: new Set(['/r/a']) });
  t.painter._kindOf = () => 'file';
  const moved = calls(t.selector, '_moveSel');
  const ev = { target: { closest: () => null }, code: 'ArrowDown', preventDefault() {}, stopPropagation() {} };
  t.keys._onKey(ev);
  assert.deepEqual(moved, [[1]]);
});

test('TC-DLG-2: 관측의 칠하기는 보는 탐색기마다 `painter` 인스턴스에 갈아 끼운 `paint` 를 부른다', () => {
  const { ctx, t } = tree();
  const store = new ctx.FileTreeStore({ edWatchSync() {} }, '/r');
  store.views.add(t);
  const painted = calls(t.painter, 'paint');
  store.paintAll();
  assert.equal(painted.length, 1);
});
