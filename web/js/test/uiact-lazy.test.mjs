import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * PERF 3.4.12.10 (M3_BOOT_SCOPE §3 `uiact`·`chat`, D-47). 처음 쓸 때 싣는 부품의 부팅 쪽 자리표시.
 *   `Screens.call` 은 묶음을 실은 뒤 묶음이 바꿔 단 같은 이름의 본체를 부른다 · 바꿔 달지 않았으면 reject 한다 ·
 *   부팅 껍데기의 동기 몫(끌기 자리 판정·센터 닫기)은 묶음 없이 돈다 · 채팅 부품은 `chat` 이 실리기 전에는 없다.
 */
function fakeDocument() {
  const added = [];
  return {
    added,
    head: { appendChild(c) { added.push(c); return c } },
    createElement: (tag) => ({ tagName: tag.toUpperCase(), remove() {} }),
    querySelector: () => null,
    getElementById: () => null,
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('Screens.call: 묶음을 실은 뒤 바꿔 단 본체를 부르고 그 값을 준다', async () => {
  const document = fakeDocument();
  const ctx = load(['core/screens.js'], { globals: { document }, expose: ['Screens'] });
  const S = ctx.Screens;
  S.register('lib');
  const proto = { m(...a) { return S.call('lib', this, 'm', a) } };
  const o = Object.create(proto);
  const p = o.m(1, 2);
  await tick();
  assert.equal(document.added.length, 1);
  assert.equal(document.added[0].src, 'b/lib.js');
  proto.m = function (a, b) { return a + b };
  document.added[0].onload();
  assert.equal(await p, 3);
});

test('Screens.call: 묶음이 본체를 달지 않았으면 다시 부르지 않고 reject 한다', async () => {
  const document = fakeDocument();
  const ctx = load(['core/screens.js'], { globals: { document }, expose: ['Screens'] });
  const S = ctx.Screens;
  S.register('lib');
  const proto = { m(...a) { return S.call('lib', this, 'm', a) } };
  const p = Object.create(proto).m();
  await tick();
  document.added[0].onload();
  await assert.rejects(p, /did not define m/);
});

function shell(files, expose, ready = false) {
  const loads = [];
  const Screens = {
    register() {}, ready: () => ready,
    load(n) { loads.push(n); return Promise.resolve() },
    call(n, self, key) { loads.push(n + ':' + key); return Promise.resolve() },
  };
  const ctx = load([...BASE, ...files], { globals: { Screens, document: fakeDocument() }, expose });
  return { ctx, loads };
}

test('LayoutDnd 껍데기: 자리 판정은 동기로 돌고 옮기기는 uiact 를 거친다', () => {
  const { ctx, loads } = shell(['core/layout-dnd.js'], ['LayoutDnd']);
  const d = new ctx.LayoutDnd({});
  const el = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  assert.equal(d.getDragZone(el, { clientX: 10, clientY: 50 }), 'left');
  assert.equal(d.getDragZone(el, { clientX: 50, clientY: 50 }), 'center');
  d.moveTabToPane('a', 't', 'b');
  d.moveTabToWindow('a', 't', 'w');
  d.splitPaneWithTab('a', 't', 'b', 'right');
  assert.deepEqual([...loads], ['uiact:moveTabToPane', 'uiact:moveTabToWindow', 'uiact:splitPaneWithTab']);
});

test('AttnCenter 껍데기: 닫기는 묶음 없이 돌고 열기·그리기는 uiact 를 거친다', () => {
  const { ctx, loads } = shell(['core/attn-center.js'], ['AttnCenter']);
  const c = new ctx.AttnCenter({});
  c._attnCenterClose();
  assert.deepEqual([...loads], []);
  c._attnCenterToggle();
  c._attnCenterRender();
  assert.deepEqual([...loads], ['uiact:_attnCenterToggle', 'uiact:_attnCenterRender']);
});

test('TermTransfer 껍데기: 올리기·내려받기는 uiact 를 거친다', () => {
  const { ctx, loads } = shell(['ui/term-transfer.js'], ['TermTransfer']);
  const x = new ctx.TermTransfer({});
  x._uploadFiles([]);
  x._downloadFile('a');
  assert.deepEqual([...loads], ['uiact:_uploadFiles', 'uiact:_downloadFile']);
});

test('ChatController: chat 이 실리기 전에는 사람 명령 부품이 없다', () => {
  const { ctx } = shell(['core/chat-store.js', 'core/chat-controller.js', 'core/chat-window.js'], ['ChatController']);
  const c = new ctx.ChatController({});
  assert.equal(c.human, null);
  assert.equal(c.views, null);
});

test('ChatWindow 껍데기: 정규화는 부팅에서 돌고 창 열기는 chat 을 거친다', () => {
  const { ctx, loads } = shell(['core/chat-window.js'], ['ChatWindow']);
  const w = new ctx.ChatWindow({ git: { isChatWin: () => false } });
  assert.equal(w._chatNormalize([]), 0);
  w.chatWindowOpen();
  w._chatOpenTab('r1');
  assert.deepEqual([...loads], ['chat:chatWindowOpen', 'chat:_chatOpenTab']);
});
