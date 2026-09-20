import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * STRUCTURE_CLEANUP_SRS 묶음 A · TC-STR-1.
 *
 * **재는 것은 "세 단으로 내려가는가" 하나다.**
 *
 * 사본 넷이 각자 1단이나 2단에서 멈춰 있었고, 그중 `app-tool.js` 는 1단만 있어
 * secure context 밖에서 **버튼이 조용히 아무 일도 안 했다** — `navigator.clipboard`
 * 가 아예 없어 호출이 던지고 빈 `catch{}` 가 삼켰기 때문이다.
 *
 * 그래서 단마다 **앞 단이 없는 경우와 실패하는 경우**를 갈라 본다. 없는 것과
 * 실패하는 것은 다른 사건이고, 결함은 "없는 것" 쪽에서 났다.
 */

/** `clipboard.js` 가 실제로 기대는 것만 세운다 (하네스의 최소 대역 규약). */
function ctxWith({ writeText, exec }) {
  const made = [];
  const el = () => {
    const e = {
      value: '', className: '', id: '', spellcheck: true, textContent: '', title: '', type: '',
      style: { cssText: '' }, dataset: {}, isConnected: true, children: [],
      setAttribute() {}, addEventListener() {}, appendChild(c) { e.children.push(c); return c },
      focus() {}, select() {}, setSelectionRange() {}, remove() { e.isConnected = false },
    };
    made.push(e);
    return e;
  };
  const document = {
    createElement: el,
    body: { appendChild: (c) => c },
    execCommand: exec,
  };
  const navigator = writeText ? { clipboard: { writeText } } : {};
  const ctx = load(['ui/clipboard.js'], {
    expose: ['ClipboardWriter'],
    globals: {
      document, navigator,
      TIMERS: { frame() {} },
      TERM_COPY_ID: 'tc', TERM_COPY_TITLE: 't', TERM_COPY_WHY: 'w',
      TERM_COPY_DO: 'do', TERM_COPY_CLOSE: 'x', TERM_COPY_MANUAL: 'm',
      TIP_COPY_DO: '', TIP_COPY_CLOSE: '',
    },
  });
  return { ctx, made };
}

test('1단이 성공하면 거기서 끝난다 (FR-ETR-40)', async () => {
  let execCalls = 0;
  const { ctx } = ctxWith({ writeText: async () => {}, exec: () => { execCalls++; return true } });
  assert.equal(await ctx.ClipboardWriter.write('x'), true);
  assert.equal(execCalls, 0, '1단이 통했는데 2단을 불렀다');
  assert.equal(ctx.ClipboardWriter._cur, null, '창이 서면 안 된다');
});

test('1단이 실패하면 2단으로 내려간다', async () => {
  let execCalls = 0;
  const { ctx } = ctxWith({
    writeText: async () => { throw new Error('denied') },
    exec: () => { execCalls++; return true },
  });
  assert.equal(await ctx.ClipboardWriter.write('x'), true);
  assert.equal(execCalls, 1);
  assert.equal(ctx.ClipboardWriter._cur, null);
});

test('1단이 **아예 없어도** 던지지 않고 2단으로 내려간다 (app-tool.js 의 결함)', async () => {
  let execCalls = 0;
  // secure context 밖: `navigator.clipboard` 자체가 없다.
  const { ctx } = ctxWith({ writeText: null, exec: () => { execCalls++; return true } });
  assert.equal(await ctx.ClipboardWriter.write('x'), true);
  assert.equal(execCalls, 1);
});

test('둘 다 실패하면 3단 복사창이 선다', async () => {
  const { ctx } = ctxWith({ writeText: null, exec: () => false });
  assert.equal(await ctx.ClipboardWriter.write('x'), false, '창은 "복사됐다" 가 아니다');
  assert.ok(ctx.ClipboardWriter._cur, '복사창이 서지 않았다');
  ctx.ClipboardWriter.close();
  assert.equal(ctx.ClipboardWriter._cur, null);
});

test('복사창은 한 번에 하나다 (FR-ETR-41)', async () => {
  const { ctx } = ctxWith({ writeText: null, exec: () => false });
  await ctx.ClipboardWriter.write('a');
  const first = ctx.ClipboardWriter._cur;
  await ctx.ClipboardWriter.write('b');
  assert.notEqual(ctx.ClipboardWriter._cur, first);
  assert.equal(first.isConnected, false, '앞의 창이 남았다');
});

test('보고 있지 않은 도구의 복사는 창을 띄우지 않는다 (FR-ETR-44)', async () => {
  const { ctx } = ctxWith({ writeText: null, exec: () => false });
  ctx.app = { attnUserIsWatching: () => false };
  assert.equal(await ctx.ClipboardWriter.write('x', 'tool-9'), false);
  assert.equal(ctx.ClipboardWriter._cur, null, '엉뚱한 창에 복사창이 섰다');
});

test('toolId 가 없으면 게이트가 걸리지 않는다 — 사용자가 부른 복사다', async () => {
  const { ctx } = ctxWith({ writeText: null, exec: () => false });
  ctx.app = { attnUserIsWatching: () => false };
  await ctx.ClipboardWriter.write('x');
  assert.ok(ctx.ClipboardWriter._cur);
});
