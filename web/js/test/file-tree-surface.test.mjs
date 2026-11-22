import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST5_SRS TC-FR5-30: FileTree 의 바깥 표면을 고정한다 — 원형 확장 여섯을 부품 클래스로 옮긴 뒤에도
 * `FileTree` 원형에서 같은 이름이 같은 종류(메서드·접근자)로 읽히고, 정적 이름도 그대로다. 나누기 전 코드에서 GREEN 이다.
 *
 * 앱·렌더러·e2e 가 탐색기 인스턴스의 메서드와 필드를 이름으로 부르고(`load`·`paint`·`revealPath`·`_onKey` 등) 시험이
 * 인스턴스의 메서드를 갈아 끼운다(`_paintAll`·`_rollup`·`_after` 등). 이름 하나가 사라지면 그 자리가 조용히 죽는다.
 */
const FILES = ['ui/file-tree-obs.js', 'ui/file-tree-store.js', 'ui/file-tree.js', 'ui/file-tree-paint.js', 'ui/file-tree-keys.js',
  'ui/file-tree-marquee.js', 'ui/file-tree-edit.js', 'ui/file-tree-xfer.js', 'ui/file-tree-download.js'];

const PROTO = [
  '_after:function', '_applyGit:function', '_askName:function', '_askUploadFailure:function', '_base:function',
  '_busy:get', '_clearErr:function', '_commitEdit:function', '_dirOwn:getset', '_dirSt:getset', '_dlOf:function',
  '_dragDownloadURL:function', '_dropClear:function', '_dropDirAt:function', '_dropUpload:function', '_el:function',
  '_elInput:function', '_fail:function', '_focusInput:function', '_forget:function', '_forgetView:function',
  '_gitBack:function', '_gitBusy:getset', '_gitOff:getset', '_gitOn:getset', '_gitRetryAt:getset', '_head:function',
  '_headBtn:function', '_ign:get', '_ignOff:getset', '_inherit:function', '_initDnd:function',
  '_initMarquee:function', '_isIgnored:function', '_isPartial:function', '_items:function', '_join:function',
  '_kids:getset', '_kindOf:function', '_loadOnce:function', '_markDrop:function', '_moveSel:function',
  '_mqDown:function', '_mqMove:function', '_mqPaint:function', '_mqScroll:function', '_mqY:function',
  '_nameReset:function', '_onClick:function', '_onCtx:function', '_onDbl:function', '_onKey:function',
  '_optimAdd:function', '_optimDel:function', '_optimMove:function', '_pad:function', '_paintAll:function',
  '_parent:function', '_partial:getset', '_prefixOf:function', '_recoverable:function', '_rekey:function',
  '_rekeyView:function', '_rel:function', '_repoPrefix:getset', '_repoRel:function', '_restore:function',
  '_restoreEditFocus:function', '_restoreOwnFocus:function', '_retargetOrFail:function', '_rollup:function',
  '_rowId:function', '_selAll:function', '_selHas:function', '_selMarquee:function', '_selOnly:function',
  '_selOrdered:function', '_selRange:function', '_selTargets:function', '_selToggle:function',
  '_selectRoot:function', '_setStatus:function', '_showNameWhy:function', '_snap:function', '_springCancel:function',
  '_springSchedule:function', '_st:getset', '_stKey:function', '_stOf:function', '_stampBusy:getset',
  '_stampOff:getset', '_targetDir:function', '_uploadOne:function', 'cancelEdit:function', 'copyPath:function',
  'destroy:function', 'doCreate:function', 'doDelete:function', 'doDuplicate:function', 'doMoveMany:function',
  'doPasteInto:function', 'doRename:function', 'doUpload:function', 'download:function', 'downloadMany:function',
  'gitDue:function', 'load:function', 'loadIgnored:function', 'mount:function', 'paint:function',
  'paintGitCached:function', 'pickUpload:function', 'pollGit:function', 'pollStamp:function', 'refresh:function',
  'reload:function', 'revealPath:function', 'startCreate:function', 'startRename:function', 'toggle:function',
];

const STATICS = ['_asUploadItems:function', '_dropEntries:function', '_isFileDrag:function', '_seq:number', '_walkEntry:function'];

function surface(files) {
  const ctx = load([...BASE, ...files], { expose: ['FileTree'] });
  const kind = (d) => (d.get || d.set ? (d.get ? 'get' : '') + (d.set ? 'set' : '') : typeof d.value);
  const P = ctx.FileTree.prototype;
  return {
    proto: Object.getOwnPropertyNames(P).filter((n) => n !== 'constructor').sort().map((n) => n + ':' + kind(Object.getOwnPropertyDescriptor(P, n))),
    statics: Object.getOwnPropertyNames(ctx.FileTree).filter((n) => !['length', 'name', 'prototype'].includes(n)).sort()
      .map((n) => n + ':' + typeof ctx.FileTree[n]),
  };
}

test('TC-FR5-30: FileTree 원형의 이름과 종류가 그대로다', () => {
  const s = surface(FILES);
  assert.ok(s.proto.length >= 100, `원형 이름을 ${s.proto.length}개밖에 못 읽었다 — 검사가 공회전한다`);
  assert.deepEqual(s.proto, PROTO);
});

test('TC-FR5-30: FileTree 의 정적 이름이 그대로다', () => {
  assert.deepEqual(surface(FILES).statics, STATICS);
});
