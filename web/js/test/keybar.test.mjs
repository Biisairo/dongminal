import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, load, plain } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS §3.11.2 (D-31) — 모바일 키바의 구성(`keybarResolve`, FR-UXF-93)과
 * 매크로 키 조합(`mkbComboBytes`·라벨·이름, FR-UXF-94). TC-UXF-92·93.
 */
const ctx = () => load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/keybar.js'], {
  expose: ['MKB_KEYS', 'keybarResolve', 'keybarRows', 'keybarReset', 'keybarMove', 'keybarToggle',
    'mkbComboBytes', 'mkbComboLabel', 'mkbComboName', 'mkbMacroValid'],
});

const DEFAULT_IDS = ['esc', 'tab', 'enter', 'ctrl', 'ctrlc', 'alt', 'up', 'down', 'left', 'right',
  'pipe', 'tilde', 'slash', 'hyphen', 'home', 'end', 'pgup', 'pgdn'];
const ids = (keys) => plain(keys).map((k) => k.act === 'kb' ? '⌨' : k.id);
const D = { id: 'm1', key: 'd', ctrl: true, alt: false, shift: false };
const B = { id: 'm2', key: 'b', ctrl: false, alt: true, shift: false };

test('TC-UXF-92: 기본 키는 고정 id 18개를 기본 순서로 갖는다', () => {
  const c = ctx();
  assert.deepEqual(plain(c.MKB_KEYS).filter((k) => k.act !== 'kb').map((k) => k.id), DEFAULT_IDS);
});

test('TC-UXF-92: 값이 없거나 객체가 아니면 지금 키바와 같다', () => {
  const c = ctx();
  for (const v of [undefined, null, 3, 'x', [], {}]) {
    assert.deepEqual(ids(c.keybarResolve(v)), ['⌨', ...DEFAULT_IDS], String(v));
  }
});

test('TC-UXF-92: order 를 따르고, 적히지 않은 기본 키·매크로가 끝에 붙는다', () => {
  const c = ctx();
  const r = ids(c.keybarResolve({ order: ['pgdn', 'm2', 'esc'], macros: [D, B] }));
  assert.deepEqual(r, ['⌨', 'pgdn', 'm2', 'esc', ...DEFAULT_IDS.filter((i) => i !== 'pgdn' && i !== 'esc'), 'm1']);
});

test('TC-UXF-92: off·알 수 없는 id 를 버리고, ⌨ 는 늘 맨 왼쪽이다', () => {
  const c = ctx();
  const r = ids(c.keybarResolve({ order: ['zzz', 'tab', 'kb', 'tab'], off: ['esc', 'm1', 'nope'], macros: [D] }));
  assert.equal(r[0], '⌨');
  assert.equal(r[1], 'tab');
  assert.ok(!r.includes('esc'));
  assert.ok(!r.includes('m1'));
  assert.ok(!r.includes('zzz'));
  assert.equal(r.filter((i) => i === 'tab').length, 1);
  assert.equal(r.filter((i) => i === '⌨').length, 1);
});

test('TC-UXF-92: 매크로는 곧바로 보내는 키로 선다(라벨 기본값·이름·바이트)', () => {
  const c = ctx();
  const m = c.keybarResolve({ macros: [D, { ...B, label: 'word←' }] }).filter((k) => k.macro);
  assert.deepEqual(plain(m.map((k) => [k.id, k.label, k.raw, k.name])), [
    ['m1', '^D', '\x04', 'Macro: Ctrl+D'],
    ['m2', 'word←', '\x1bb', 'Macro: Alt+B'],
  ]);
});

test('TC-UXF-92: 틀린 매크로(수식 없음·알 수 없는 키·라벨 9자)는 서지 않거나 라벨을 되돌린다', () => {
  const c = ctx();
  const r = c.keybarResolve({ macros: [
    { id: 'x1', key: 'd', ctrl: false, alt: false, shift: false },
    { id: 'x2', key: 'f13', ctrl: true },
    { id: 'x3', key: 'e', ctrl: true, label: '123456789' },
  ] }).filter((k) => k.macro);
  assert.deepEqual(plain(r.map((k) => [k.id, k.label])), [['x3', '^E']]);
  assert.equal(c.mkbMacroValid({ key: 'd', ctrl: false, alt: false, shift: false }), false);
  assert.equal(c.mkbMacroValid({ key: 'd', shift: true }), true);
});

test('TC-UXF-92: keybarRows 는 꺼진 키도 켜기 표시와 함께 늘어놓는다(⌨ 없음)', () => {
  const c = ctx();
  const rows = c.keybarRows({ off: ['esc'], macros: [D] });
  assert.equal(rows.length, 19);
  assert.equal(rows[0].key.id, 'esc');
  assert.equal(rows[0].on, false);
  assert.equal(rows[1].on, true);
  assert.equal(rows[18].key.id, 'm1');
});

test('TC-UXF-92: 기본값으로는 순서·켜기만 되돌리고 매크로는 남긴다', () => {
  const c = ctx();
  assert.deepEqual(plain(c.keybarReset({ order: ['tab'], off: ['esc'], macros: [D] })), { macros: [D] });
});

test('TC-UXF-92: 위·아래는 한 칸 옮기고 끝에서는 그대로다', () => {
  const c = ctx();
  const up = c.keybarMove({}, 'tab', -1);
  assert.deepEqual(ids(c.keybarResolve(up)).slice(1, 3), ['tab', 'esc']);
  const top = c.keybarMove({}, 'esc', -1);
  assert.deepEqual(ids(c.keybarResolve(top)).slice(1, 3), ['esc', 'tab']);
  const down = c.keybarMove({ macros: [D] }, 'pgdn', 1);
  assert.deepEqual(ids(c.keybarResolve(down)).slice(-2), ['m1', 'pgdn']);
});

test('TC-UXF-92: 켜기·끄기는 off 목록을 고친다', () => {
  const c = ctx();
  const off = c.keybarToggle({}, 'esc', false);
  assert.deepEqual(plain(off.off), ['esc']);
  assert.deepEqual(plain(c.keybarToggle(off, 'esc', true).off), []);
});

test('TC-UXF-93: mkbComboBytes — 표의 바이트', () => {
  const c = ctx();
  const b = (key, mods) => c.mkbComboBytes({ key, ctrl: false, alt: false, shift: false, ...mods });
  assert.equal(b('d', { ctrl: true }), '\x04');
  assert.equal(b('b', { alt: true }), '\x1bb');
  assert.equal(b('c', { ctrl: true, alt: true }), '\x1b\x03');
  assert.equal(b('a', { shift: true }), 'A');
  assert.equal(b('tab', { shift: true }), '\x1b[Z');
  assert.equal(b('up', { ctrl: true }), '\x1b[1;5A');
  assert.equal(b('pgdn', { alt: true, shift: true }), '\x1b[6;4~');
  assert.equal(b('space', { ctrl: true }), '\x00');
  assert.equal(b('/', { ctrl: true }), '\x1f');
  assert.equal(b('[', { ctrl: true }), '\x1b');
  assert.equal(b('\\', { ctrl: true }), '\x1c');
  assert.equal(b('backspace', { ctrl: true }), '\x08');
  assert.equal(b('backspace', { alt: true }), '\x1b\x7f');
  assert.equal(b('enter', { ctrl: true }), '\r');
  assert.equal(b('esc', { alt: true }), '\x1b\x1b');
  assert.equal(b('5', { ctrl: true }), '5');
  assert.equal(b('home', { shift: true }), '\x1b[1;2H');
  assert.equal(b('end', { ctrl: true, alt: true, shift: true }), '\x1b[1;8F');
  assert.equal(b('left', { alt: true }), '\x1b[1;3D');
  assert.equal(b('pgup', { ctrl: true }), '\x1b[5;5~');
});

test('TC-UXF-93: 라벨 기본값과 길게 누르면 뜨는 이름', () => {
  const c = ctx();
  const m = (key, mods) => ({ key, ctrl: false, alt: false, shift: false, ...mods });
  assert.equal(c.mkbComboLabel(m('d', { ctrl: true })), '^D');
  assert.equal(c.mkbComboLabel(m('b', { alt: true })), '⌥B');
  assert.equal(c.mkbComboLabel(m('up', { ctrl: true, shift: true })), '^⇧↑');
  assert.equal(c.mkbComboLabel(m('space', { ctrl: true, alt: true, shift: true })), '^⌥⇧Space');
  assert.equal(c.mkbComboName(m('up', { ctrl: true, shift: true })), 'Macro: Ctrl+Shift+Up');
  assert.equal(c.mkbComboName(m('pgdn', { alt: true })), 'Macro: Alt+PageDown');
});
