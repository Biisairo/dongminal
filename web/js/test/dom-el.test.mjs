import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REFACTOR3_FE_BASE_SRS TC-FEB-1 (FR-FEB-1) — DOM 생성 헬퍼 한 벌. 파일마다 따로 있던 `actEl`·`chatEl`·`runDiv`·
 * `runSvg`·`meshSvg`·`_span` 등이 이것을 쓴다. 만들어진 원소의 태그·클래스·글자·속성·네임스페이스가 같아야 한다.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** 태그·네임스페이스를 적는 최소 원소. `className` 은 대입했는지까지 본다(빈 글자도 속성이 선다). */
function el(tag, ns) {
  const e = { tagName: tag, ns, attrs: {}, set: [], _text: undefined };
  Object.defineProperty(e, 'className', { set(v) { e.set.push('class'); e._cls = v }, get() { return e._cls } });
  Object.defineProperty(e, 'textContent', { set(v) { e.set.push('text'); e._text = v }, get() { return e._text } });
  e.setAttribute = (k, v) => { e.attrs[k] = String(v) };
  return e;
}

const ctx = load(['core/helpers.js'], {
  globals: {
    document: {
      addEventListener() {},
      createElement: (tag) => el(tag, HTML_NS),
      createElementNS: (ns, tag) => el(tag, ns),
    },
  },
});

test('domEl: 태그·클래스·글자를 세운다', () => {
  const e = ctx.domEl('span', 'a b', 'hi');
  assert.equal(e.tagName, 'span');
  assert.equal(e.ns, HTML_NS);
  assert.equal(e.className, 'a b');
  assert.equal(e.textContent, 'hi');
});

test('domEl: 글자를 주지 않으면 글자를 건드리지 않는다', () => {
  const e = ctx.domEl('div', 'x');
  assert.equal(JSON.stringify(e.set), JSON.stringify(['class']));
});

test('domEl: 빈 클래스도 대입한다(종전 헬퍼와 같다)', () => {
  const e = ctx.domEl('div', '');
  assert.equal(JSON.stringify(e.set), JSON.stringify(['class']));
  assert.equal(e.className, '');
});

test('domEl: 수와 빈 글자도 글자로 적는다', () => {
  assert.equal(ctx.domEl('span', 'n', 0).textContent, 0);
  assert.equal(JSON.stringify(ctx.domEl('span', 'n', '').set), JSON.stringify(['class', 'text']));
});

test('svgEl: SVG 네임스페이스로 만들고 속성을 글자로 적는다', () => {
  const e = ctx.svgEl('rect', { x: 1, class: 'r', 'stroke-width': 2 });
  assert.equal(e.tagName, 'rect');
  assert.equal(e.ns, SVG_NS);
  assert.equal(JSON.stringify(e.attrs), JSON.stringify({ x: '1', class: 'r', 'stroke-width': '2' }));
});

test('svgEl: 속성이 없어도 된다', () => {
  const e = ctx.svgEl('g');
  assert.equal(e.ns, SVG_NS);
  assert.equal(JSON.stringify(e.attrs), '{}');
});
