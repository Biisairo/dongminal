import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * REFACTOR3_FE_REST5_SRS TC-FR5-50 (D-FR5-9): `TerminalTool` 의 바깥 표면과 갈아 끼우기 경로를 고정한다 — 몸을 부품
 * (`TermTransfer`·`TermHeld`·`TermOutput`·`TermFit`)으로 옮긴 뒤에도 원형에서 같은 이름이 같은 종류로 읽히고, 인스턴스에
 * 갈아 끼운 메서드를 부품 안의 호출도 본다. 나누기 전 코드에서 GREEN 이다.
 *
 * e2e 가 부품의 `_handleOutput`·`_doFlush`·`_onCwd`·`_uploadFiles` 를 감싸고, 단위 시험이 크기 판정
 * (`_refreshForWidth`·`_applyPtySize`·`_followsPty`)과 보류 배너(`_heldBanner`)를 갈아 끼운다. 부품의 이름은 원형에
 * 위임자로 두지 않는다 — 부르는 쪽이 `p.sizer.doFit()` 처럼 부품을 부른다 (REFACTOR3_FE_DELEG_SRS).
 */
const PROTO = [
  '_applyStickyMods:function', '_blurInput:function', '_clipKey:function', '_copySelection:function',
  '_dispatchWheel:function', '_exitClose:function', '_exitNewShell:function',
  '_exitSpot:function', '_flingStop:function', '_flushSendQueue:function', 
  
  '_hideOverlay:function', '_imeBusy:function', '_imeClose:function', '_imeFlush:function',
  '_imeGate:function', '_imeKeyInit:function', '_imePush:function', '_initTouchScroll:function', '_kbAllow:function',
  '_kbApply:function', '_kbSuppress:function', '_kbSuppressed:function', '_kbTextarea:function', '_loadAddons:function',
  '_mappedKey:function', '_markExited:function', '_onAltMode:function', '_onBeforeInput:function', 
  '_onEraseDisplay:function', '_onOp:function', '_onSeq:function', '_onTermData:function',
  '_onWsOpen:function', '_onWsReady:function', 
  '_resetDecoderIfNoResume:function', '_retryDelay:getset', '_rowHeight:function', '_scheduleReconnect:function',
  '_send:function', '_sendDropCount:get', '_sendKey:function', '_sendQueue:getset', '_sendQueueMax:get',
  '_sendResize:function', '_sendText:function', '_sendUserFrame:function', '_showOverlay:function', '_termOpenArgs:function', '_toast:function',
  '_touchScrollBy:function', '_tsAck:function', '_tsEnd:function', '_tsFollow:function', '_tsInflightRoom:function',
  '_tsLines:function', '_tsLprMeasure:function', '_tsMouseMode:function', '_tsMove:function', '_tsOnWrite:function',
  '_tsStart:function', '_tsTouch:function', '_tsUnfollow:function', '_userInput:function',
  '_wheelKick:function', '_wireContextMenu:function', '_wireIme:function', '_wireKeys:function',
  '_wireNativeSelect:function', '_wsLost:function', '_wsOpened:function', '_wsStopped:function',
  'connect:function', 'destroy:function', 'focus:function', 'open:function',
  'reconnectNow:function', 'sleep:function', 'wake:function', 'write:function', 'ws:get',
];

function pane(globals = {}) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock,
    globals: Object.assign({ CWD_API: '/api/cwd', UPLOAD_API: '/api/upload' }, globals),
    expose: ['TerminalTool', 'OP'],
  });
  ctx.app = { resizeCheck: () => true, isMobile: false };
  const p = new ctx.TerminalTool('t1', 'tool');
  return { ctx, p, clock };
}

/** 부품 → 그 부품이 가진 이름. 터미널 원형에는 없다 (REFACTOR3_FE_DELEG_SRS). */
const PARTS = {
  sizer: ['_followsPty', '_applyPtySize', '_onSize', 'doFit', 'applyFontSize', 'ptySize', '_refreshForWidth'],
  heldBar: ['_heldMaybeShow', '_heldBanner', '_heldHide', '_heldSend', '_heldDiscard'],
  output: ['_handleOutput', '_oscCarryAt', '_doFlush', '_onCwd'],
  xfer: ['_wireDnd', '_downloadFile', '_uploadFiles', '_fmtSize'],
};

const calls = (p, name) => {
  const seen = [];
  p[name] = (...a) => { seen.push(a) };
  return seen;
};

test('TC-FR5-50: TerminalTool 원형의 이름과 종류가 그대로다', () => {
  const { ctx } = pane();
  const kind = (d) => (d.get || d.set ? (d.get ? 'get' : '') + (d.set ? 'set' : '') : typeof d.value);
  const P = ctx.TerminalTool.prototype;
  const got = Object.getOwnPropertyNames(P).filter((n) => n !== 'constructor').sort()
    .map((n) => n + ':' + kind(Object.getOwnPropertyDescriptor(P, n)));
  assert.deepEqual(got, PROTO);
});

test('TC-DLG-1: 부품의 이름은 부품 원형에 있고 터미널 원형에는 없다', () => {
  const { ctx, p } = pane();
  for (const [part, names] of Object.entries(PARTS)) {
    for (const n of names) {
      assert.equal(typeof Object.getPrototypeOf(p[part])[n], 'function', part + '.' + n);
      assert.ok(!(n in ctx.TerminalTool.prototype), '위임자가 남았다: ' + n);
    }
  }
});

test('TC-FR5-50: 출력은 인스턴스의 `_doFlush` 를 미뤄 부른다', async () => {
  const { p, clock } = pane();
  const seen = calls(p.output, '_doFlush');
  p.output._handleOutput(new TextEncoder().encode('ab'));
  p.output._handleOutput(new TextEncoder().encode('c'));
  assert.equal(seen.length, 0);
  await clock.advance(10);
  assert.equal(seen.length, 1, '두 청크가 한 번의 flush 로 모인다');
  assert.equal(p._outputBuf, 'abc');
});

test('TC-FR5-50: flush 는 OSC 777 을 인스턴스의 `_onCwd`·`_downloadFile` 로 보내고 나머지를 쌓는다', () => {
  const { p } = pane();
  const cwd = calls(p.output, '_onCwd');
  const dl = calls(p.xfer, '_downloadFile');
  p._outputBuf = 'a\x1b]777;Cwd;/x\x07b\x1b]777;Download;/y\x07c';
  p.output._doFlush();
  assert.deepEqual(cwd, [['/x']]);
  assert.deepEqual(dl, [['/y']]);
  assert.equal(p._buf.length, 1, '터미널이 아직 없으면 버퍼에 쌓인다');
  assert.equal(new TextDecoder().decode(p._buf[0]), 'abc');
});

test('TC-FR5-50: 끝나지 않은 OSC 는 인스턴스의 `_oscCarryAt` 이 자른 자리에서 남긴다', () => {
  const { p } = pane();
  p.output._oscCarryAt = () => 1;
  p._outputBuf = 'xyz';
  p.output._doFlush();
  assert.equal(p._outputBuf, 'yz');
  assert.equal(new TextDecoder().decode(p._buf[0]), 'x');
  assert.ok(p._carryTimer, '보류분을 흘려보낼 타이머를 건다');
});

test('TC-FR5-50: `_onCwd` 는 포커스 터미널이면 상태바와 git 신호를 부른다', () => {
  const { ctx, p } = pane();
  const signals = [];
  let bar = 0;
  Object.assign(ctx.app, {
    cwd: '/old',
    git: { gitSignal: (k) => { signals.push(k) } }, statusbar: { updateStatusBar: () => { bar++ } }, tool: { search: { focusedTerminal: () => p } },
  });
  p.output._onCwd('/new');
  assert.equal(p._cwd, '/new');
  assert.equal(ctx.app.cwd, '/new');
  assert.equal(bar, 1);
  assert.deepEqual(signals, ['cwd']);
});

test('TC-FR5-50: 크기 통보는 인스턴스의 `_applyPtySize` 를 부른다', () => {
  const { ctx, p } = pane();
  const seen = calls(p.sizer, '_applyPtySize');
  const d = new Uint8Array(5);
  d[0] = ctx.OP.SIZE;
  new DataView(d.buffer).setUint16(1, 80, false);
  new DataView(d.buffer).setUint16(3, 24, false);
  p._onOp(d);
  assert.equal(seen.length, 1);
  assert.equal(p._ptyCols, 80);
  assert.equal(p._ptyRows, 24);
});

test('TC-FR5-50: `doFit` 은 인스턴스의 `_followsPty` 답으로 가른다', () => {
  const { p } = pane();
  let fits = 0;
  p.term = { cols: 100, rows: 30 };
  p.fit = { fit: () => { fits++ } };
  const applied = calls(p.sizer, '_applyPtySize');
  p.sizer._followsPty = () => true;
  p.sizer.doFit();
  assert.equal(fits, 0);
  assert.equal(applied.length, 1);
  p.sizer._followsPty = () => false;
  p.sizer.doFit();
  assert.equal(fits, 1);
  assert.equal(p._ownCols, 100);
});

test('TC-FR5-50: `ptySize` 는 폭이 바뀌면 인스턴스의 `doFit`·`_refreshForWidth` 를 부른다', () => {
  const { p } = pane();
  p.term = { cols: 100, rows: 30 };
  p.el = { classList: { contains: (c) => c === 'vis' } };
  p.sizer.doFit = () => { p.term.cols = 120; p._ownCols = 120; p._ownRows = 30 };
  const seen = calls(p.sizer, '_refreshForWidth');
  assert.deepEqual(JSON.parse(JSON.stringify(p.sizer.ptySize())), { cols: 120, rows: 30 });
  assert.equal(seen.length, 1);
});

test('TC-FR5-50: 글꼴 크기는 인스턴스의 `doFit` 으로 다시 잰다', () => {
  const { ctx, p } = pane();
  ctx.termFontSizeNow = () => 17;
  p.term = { options: { fontSize: 13 } };
  const seen = calls(p.sizer, 'doFit');
  p.sizer.applyFontSize();
  assert.equal(p.term.options.fontSize, 17);
  assert.equal(seen.length, 1);
});

test('TC-FR5-50: 보류분이 있으면 인스턴스의 `_heldBanner` 를, 보내기는 `_sendUserFrame`·`_heldHide`·`focus` 를 부른다', () => {
  const { p } = pane();
  const banner = calls(p.heldBar, '_heldBanner');
  p.heldBar._heldMaybeShow();
  assert.equal(banner.length, 0);
  p._sock.held.push(new Uint8Array([0, 97]));
  p._sock.heldBytes = 1;
  p.heldBar._heldMaybeShow();
  assert.equal(banner.length, 1);
  const sent = calls(p, '_sendUserFrame');
  const hide = calls(p.heldBar, '_heldHide');
  const focus = calls(p, 'focus');
  p.heldBar._heldSend();
  assert.equal(sent.length, 1);
  assert.equal(hide.length, 1);
  assert.equal(focus.length, 1);
});

test('TC-FR5-50: 종료 통보는 인스턴스의 `_heldHide`·`_showOverlay` 를 부른다', () => {
  const { ctx, p } = pane();
  const hide = calls(p.heldBar, '_heldHide');
  const ov = calls(p, '_showOverlay');
  p._onOp(new Uint8Array([ctx.OP.EXIT]));
  assert.equal(p._exited, true);
  assert.equal(hide.length, 1);
  assert.equal(ov.length, 1);
});

test('TC-FR5-50: 올리기는 cwd 가 없다는 답에 인스턴스의 `_toast` 로 알린다', async () => {
  const { p } = pane({ apiGet: () => Promise.resolve({ ok: false }) });
  const seen = calls(p, '_toast');
  p.xfer._uploadFiles([]);
  p.xfer._uploadFiles([{ name: 'a' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], 'err');
});

test('TC-FR5-50: 올리기는 파일마다 인스턴스의 `_toast` 와 `_fmtSize` 를 지난다', async () => {
  const posted = [];
  class FD { constructor() { this.parts = [] } append(k, v) { this.parts.push([k, v]) } }
  const { p } = pane({
    FormData: FD,
    apiGet: () => Promise.resolve({ ok: true, data: { actions: { 'term.upload': { ok: true } } } }),
    apiPost: (_u, fd) => { posted.push(fd.parts); return Promise.resolve({ ok: true, data: { name: 'b.txt', size: 5 } }) },
  });
  const updates = [];
  p._toast = () => ({ update: (_text, kind) => { updates.push(kind) } });
  const sizes = [];
  p.xfer._fmtSize = (b) => { sizes.push(b); return b + 'B' };
  p.xfer._uploadFiles([{ file: { name: 'b.txt' }, relPath: 'd/b.txt' }, { name: 'c.txt' }]);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0].map((x) => x[0]), ['relPath', 'file'], 'relPath 를 file 보다 먼저 싣는다');
  assert.deepEqual(updates, ['ok', 'ok']);
  assert.deepEqual(sizes, [5, 5]);
});
