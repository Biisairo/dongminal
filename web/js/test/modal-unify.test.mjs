import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-5 (FEC-27): 확인·알림 상자는 `UIKit.ask`(→ `UIKit.modal`)를
 * 지난다. 오버레이 생성·Escape·바깥 클릭·dialogOpen·한 번만 닫기를 자리마다 다시 적지 않는다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(JS, f), 'utf8');

for (const f of ['core/app-tool.js', 'core/app-editor-file.js']) {
  test(f + ' 에 손으로 짠 모달 골격이 없다', () => {
    const s = read(f);
    assert.doesNotMatch(s, /UIKit\.dialogOpen\(/, 'dialogOpen 을 직접 부른다');
    assert.doesNotMatch(s, /className='confirm-overlay/, '오버레이를 직접 만든다');
    assert.doesNotMatch(s, /addEventListener\('keydown'/, 'Escape 를 직접 듣는다');
  });
}

test('UIKit.ask 는 UIKit.modal 위에 선다', () => {
  const s = read('ui/ui-kit.js');
  const i = s.indexOf('  ask(spec) {');
  assert.ok(i >= 0, 'UIKit.ask 가 있다');
  assert.match(s.slice(i, s.indexOf('\n  },', i)), /this\.modal\(/);
});

/**
 * UI_KIT_SRS FR-UIK-25·§3.6 (OPTIMIZE_REFACTOR_SRS FR-OPT-11-5 후속): 킷 모달의 Escape 는 옮기기 전 다섯 상자가 하던
 * 대로 **기본 동작도 막고** 전파도 끊는다 — 안쪽 상자 하나만 닫힌다.
 */
test('UIKit.modal 의 Escape 는 preventDefault·stopPropagation 을 하고 닫는다', () => {
  const keys = [];
  const el = () => ({
    className: '', style: {}, children: [], parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c },
    removeChild(c) { c.parentNode = null },
    addEventListener() {},
  });
  const document = {
    createElement: el,
    addEventListener: (t, fn, cap) => { if (t === 'keydown') keys.push({ fn, cap }) },
    removeEventListener: () => {},
  };
  const ctx = load(['ui/ui-kit.js'], { expose: ['UIKit'], globals: { document } });
  ctx.UIKit.dialogOpen = () => () => {};
  let closed = 0;
  ctx.UIKit.modal({ head: false, onClose: () => { closed++ } });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].cap, true, 'Escape 는 캡처에서 잡는다');
  let prevented = 0, stopped = 0;
  keys[0].fn({ key: 'Escape', preventDefault: () => { prevented++ }, stopPropagation: () => { stopped++ } });
  assert.equal(closed, 1);
  assert.equal(stopped, 1, '전파를 끊지 않았다');
  assert.equal(prevented, 1, '기본 동작을 막지 않았다');
});

/**
 * FR-OPT-16-4: 킷 모달이 겹치면 Escape 는 **가장 안쪽** 하나만 닫는다.
 *
 * 모달마다 document 에 캡처 리스너를 건다. 같은 노드의 리스너는 등록 순서로 돌고
 * `stopPropagation()` 은 같은 노드의 다른 리스너를 막지 못한다 — 그래서 먼저 연
 * 바깥 것이 먼저 받아 닫혔다. 대역은 그 규칙(등록 순서·`stopImmediatePropagation`
 * 만 멈춘다)을 그대로 흉내낸다. `dialogOpen` 은 진짜를 쓴다 — 스택이 거기 있다.
 */
test('겹친 UIKit.modal 의 Escape 는 가장 안쪽만 닫는다', () => {
  let keys = [];
  const el = () => ({
    className: '', style: {}, children: [], parentNode: null, attrs: {}, isConnected: true,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c },
    removeChild(c) { c.parentNode = null },
    addEventListener() {},
    setAttribute(k, v) { this.attrs[k] = v },
    hasAttribute(k) { return k in this.attrs },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
  });
  const document = {
    createElement: el,
    activeElement: null,
    addEventListener: (t, fn, cap) => { if (t === 'keydown' && cap) keys.push(fn) },
    removeEventListener: (t, fn, cap) => { if (t === 'keydown' && cap) keys = keys.filter((f) => f !== fn) },
  };
  const TIMERS = { frame() {} };
  const ctx = load(['ui/ui-kit.js'], { expose: ['UIKit'], globals: { document, TIMERS } });
  const closed = [];
  ctx.UIKit.modal({ head: false, onClose: () => { closed.push('outer') } });
  ctx.UIKit.modal({ head: false, onClose: () => { closed.push('inner') } });

  const press = () => {
    let halt = false;
    const e = {
      key: 'Escape', preventDefault() {}, stopPropagation() {},
      stopImmediatePropagation() { halt = true },
    };
    for (const fn of [...keys]) { if (halt) break; fn(e) }
  };
  press();
  assert.deepEqual(closed, ['inner'], '바깥이 먼저(또는 함께) 닫혔다');
  press();
  assert.deepEqual(closed, ['inner', 'outer']);
});
