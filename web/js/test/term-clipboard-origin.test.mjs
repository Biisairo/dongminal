import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/ui/term-clipboard.js` — 복사는 복사한 화면의 것이다
 * (COPY_POPUP_ORIGIN_SRS FR-CPO-1~6).
 *
 * 접수: *"A 브라우저에서 claude 를 드래그하여 복사 후 B 브라우저로 가면 복사 팝업
 * 모달이 뜬다."* OSC 52 는 붙어 있는 모든 브라우저로 가고, 판정은 **xterm 이 처리하는
 * 순간**에 걸려 있었다. 처리는 도착보다 늦을 수 있다 — 뒤에 있는 페이지의 타이머 억제,
 * 그리고 옛 OSC 52 를 다시 파싱하는 전량 재생.
 *
 * 그래서 이 파일의 xterm 가짜는 **처리를 미룬다**. `write` 는 쌓기만 하고 `drain()` 이
 * 부를 때 파싱한다 — 실제 xterm 이 콜백을 파싱 **뒤에** 부르는 순서 그대로다.
 */
function rig(opts = {}) {
  // `_decode` 는 atob·TextDecoder 로 푼다. 문맥에 없으면 빈 문자열이 되어 **아무것도
  // 복사하지 않은 채** 통과한다 — 착수 때 V-CPO-6 이 그렇게 공회전했다.
  const ctx = load(['ui/clipboard.js', 'ui/term-clipboard.js'], {
    expose: ['ClipboardWriter', 'TermClipboard'],
    globals: { TextDecoder, atob: globalThis.atob },
  });
  const copied = [];
  ctx.ClipboardWriter.write = (text) => { copied.push(text); return Promise.resolve(true) };
  // "쓰는 화면" 의 세 재료 — OS 포커스·활성 탭(attnUserIsWatching)과 소유권(resizeCheck).
  const st = { watch: opts.watch !== false, own: opts.own !== false };
  ctx.app = { attnUserIsWatching: () => st.watch, resizeCheck: () => st.own };

  let osc = null;
  const pending = [];
  const term = {
    parser: { registerOscHandler: (id, fn) => { if (id === 52) osc = fn } },
    write: (text, cb) => { pending.push([text, cb]) },
  };
  const pane = { id: 't1', _slot: 0, _seqLive: opts.live !== false, _outputBuf: '', term };
  ctx.TermClipboard.attach(term, 't1', pane);

  return {
    ctx, pane, st, copied,
    arrive: () => ctx.TermClipboard.arrive(pane),
    feed: (text) => ctx.TermClipboard.feed(pane, text),
    // 쌓인 쓰기를 순서대로 파싱한다. OSC 52 를 만나면 핸들러, 끝나면 그 쓰기의 콜백.
    drain: () => {
      while (pending.length) {
        const [text, cb] = pending.shift();
        const re = /\x1b\]52;([^\x07]*)\x07/g;
        let m;
        while ((m = re.exec(text)) !== null) osc(m[1]);
        if (cb) cb();
      }
    },
  };
}

const osc52 = (s) => '\x1b]52;c;' + Buffer.from(s, 'utf8').toString('base64') + '\x07';

test('쓰는 화면에서 라이브로 도착하면 복사한다 — A 는 종전대로 (V-CPO-4)', () => {
  const r = rig();
  r.arrive();
  r.feed(osc52('mine'));
  r.drain();
  assert.deepEqual([...r.copied], ['mine']);
});

test('도착할 때 쓰는 화면이 아니었으면 늦게 처리돼도 복사하지 않는다 — 길 ① (V-CPO-1)', () => {
  const r = rig({ watch: false });
  r.arrive();                    // B: 뒤에 있는 동안 도착한다
  r.feed(osc52('from-A'));
  r.st.watch = true;             // 사용자가 B 로 온다 — 이제 포커스가 있다
  r.drain();                     // xterm 이 그제야 파싱한다
  assert.equal(r.copied.length, 0, 'B 로 오는 순간 A 의 복사가 B 에서 실행됐다 — 접수된 증상이다');
});

test('다른 컴퓨터 — 포커스가 있어도 소유자가 아니면 복사하지 않는다 — 길 ② (V-CPO-2)', () => {
  const r = rig({ watch: true, own: false });
  r.arrive();
  r.feed(osc52('from-A'));
  r.drain();
  assert.equal(r.copied.length, 0, '그 컴퓨터의 OS 포커스는 사용자가 보고 있다는 뜻이 아니다');
});

test('재생으로 도착한 OSC 52 는 복사가 아니다 — 길 ③ (V-CPO-3)', () => {
  const r = rig({ live: false });
  r.arrive();                    // OpSeq 전 — 재생 바이트다
  r.feed(osc52('old-copy'));
  r.drain();
  assert.equal(r.copied.length, 0, '재접속마다 옛 복사가 다시 실행된다 — 클립보드가 옛 내용으로 덮인다');
});

test('한 묶음에 쓰지 않을 때 도착한 조각이 섞이면 그 묶음은 복사하지 않는다 (V-CPO-5)', () => {
  const r = rig();
  r.arrive();                    // 쓰는 중에 한 조각
  r.st.watch = false;
  r.arrive();                    // 떠난 뒤에 한 조각 — 같은 flush 에 묶인다
  r.feed(osc52('mixed'));
  r.drain();
  assert.equal(r.copied.length, 0);
});

test('막힌 묶음 뒤의 다음 묶음은 새로 판정한다 (FR-CPO-5)', () => {
  const r = rig({ watch: false });
  r.arrive();
  r.feed(osc52('blocked'));
  r.st.watch = true;
  r.arrive();
  r.feed(osc52('next'));
  r.drain();
  assert.deepEqual([...r.copied], ['next'], '한 번 막힌 판정이 다음 묶음까지 따라왔다');
});

test('보류된 조각이 남으면 판정을 이어 간다 — 그 조각도 같은 도착의 것이다 (FR-CPO-5)', () => {
  const r = rig({ watch: false });
  r.arrive();
  r.pane._outputBuf = '\x1b]52;c;';   // OSC 조각이 다음 flush 로 넘어간다
  r.feed('prefix');
  r.st.watch = true;
  r.pane._outputBuf = '';
  r.feed(osc52('tail-of-blocked'));   // 새 도착 없이 이어진 나머지
  r.drain();
  assert.equal(r.copied.length, 0, '보류된 조각의 판정이 풀렸다');
});

test('도착 경로를 지나지 않은 쓰기의 OSC 52 는 하지 않는다 (V-CPO-6)', () => {
  const r = rig();
  r.pane.term.write(osc52('bypass'));  // 열리기 전 버퍼 등 — 도착 판정이 없다
  r.drain();
  assert.equal(r.copied.length, 0, '도착 판정이 없는 것을 참으로 읽었다');
});

test('핸들러는 언제나 처리했다고 답한다 — 잔재를 찍지 않는다 (FR-ETR-42 그대로)', () => {
  const r = rig({ watch: false });
  let ret = null;
  const term = { parser: { registerOscHandler: (_id, fn) => { ret = fn } }, write() {} };
  r.ctx.TermClipboard.attach(term, 't2', { ...r.pane, term });
  assert.equal(ret('c;' + Buffer.from('x').toString('base64')), true);
});
