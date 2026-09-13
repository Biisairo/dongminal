import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/i18n.js` — 카탈로그 모듈의 계약 (M8_UNIFIED_SRS FR-B-2·4·5·7, TC-B-8).
 *
 * 브라우저를 띄우지 않는다. 읽는 함수 둘(`t`·`tn`)과 정적 문구 채움(`I18N.apply`)은
 * DOM 의 최소 대역(`querySelectorAll`·`setAttribute`·`dataset`)에만 기댄다.
 */

/** `data-i18n*` 를 단 최소 원소. */
function el(dataset) {
  const attrs = {};
  return {
    dataset, textContent: '', attrs,
    setAttribute(k, v) { attrs[k] = v },
    getAttribute(k) { return attrs[k] === undefined ? null : attrs[k] },
  };
}

/** 카탈로그 모듈만 싣는다. 로케일은 `localStorage` 가 정한다 (D-B-1). */
function i18n(stored, opts = {}) {
  const warnings = [];
  const html = { lang: 'en', setAttribute(k, v) { this[k] = v } };
  const elements = opts.elements || [];
  const ctx = load(['core/i18n.js'], {
    expose: ['I18N', 'I18N_LOCALES', 'I18N_DEFAULT', 'I18N_STORAGE_KEY'],
    globals: {
      localStorage: {
        getItem: (k) => (k === 'dm.locale' ? stored : null),
        setItem() {},
      },
      console: { ...console, warn: (...a) => { warnings.push(a.join(' ')) } },
      document: {
        documentElement: html,
        querySelectorAll: () => elements,
      },
    },
  });
  ctx.I18N.register('ko', {
    'x.hello': '안녕 {name}',
    'x.only_ko': '한국어만',
    'x.files.other': '파일 {n}개',
    'html.btn': '버튼',
    'html.tip': '도움말 {key}',
  });
  ctx.I18N.register('en', {
    'x.hello': 'Hello {name}',
    'x.files.one': '{n} file',
    'x.files.other': '{n} files',
    'html.btn': 'Button',
    'html.tip': 'Help {key}',
  });
  return { ctx, warnings, html, t: ctx.t, tn: ctx.tn, I18N: ctx.I18N };
}

test('기본 로케일은 ko 다 — 저장값이 없거나 지원 밖이면 (FR-B-1)', () => {
  assert.equal(i18n(null).I18N.locale, 'ko');
  assert.equal(i18n('fr').I18N.locale, 'ko');
  assert.equal(i18n('en').I18N.locale, 'en');
});

test('t: 활성 로케일의 문장에 {name} 을 치환한다 (FR-B-2)', () => {
  const ko = i18n('ko');
  assert.equal(ko.t('x.hello', { name: '동민' }), '안녕 동민');
  const en = i18n('en');
  assert.equal(en.t('x.hello', { name: 'Dongmin' }), 'Hello Dongmin');
});

test('t: 치환되지 않은 자리표시자는 그대로 남는다 — 결함이 보인다', () => {
  assert.equal(i18n('ko').t('x.hello'), '안녕 {name}');
});

test('t: 미번역 키는 ko 로 떨어지고 경고는 키마다 한 번이다 (FR-B-4)', () => {
  const en = i18n('en');
  assert.equal(en.t('x.only_ko'), '한국어만');
  assert.equal(en.t('x.only_ko'), '한국어만');
  assert.equal(en.warnings.length, 1, '같은 키의 경고가 거듭 났다');
  assert.match(en.warnings[0], /x\.only_ko/);
  assert.match(en.warnings[0], /en/);
});

test('t: ko 에도 없으면 키 자체를 돌려주고 경고한다', () => {
  const ko = i18n('ko');
  assert.equal(ko.t('x.nope'), 'x.nope');
  assert.equal(ko.warnings.length, 1);
});

test('t: ko 에서는 ko 카탈로그에 있는 키에 경고가 없다', () => {
  const ko = i18n('ko');
  ko.t('x.hello', { name: 'a' });
  ko.t('x.only_ko');
  assert.equal(ko.warnings.length, 0);
});

test('tn: en 은 one/other 를 고르고 {n} 이 자동으로 들어간다 (FR-B-2 복수형)', () => {
  const en = i18n('en');
  assert.equal(en.tn('x.files', 1), '1 file');
  assert.equal(en.tn('x.files', 2), '2 files');
  assert.equal(en.tn('x.files', 0), '0 files');
});

test('tn: ko 는 .other 만 있어도 된다', () => {
  const ko = i18n('ko');
  assert.equal(ko.tn('x.files', 1), '파일 1개');
  assert.equal(ko.tn('x.files', 3), '파일 3개');
  assert.equal(ko.warnings.length, 0);
});

test('<html lang> 이 활성 로케일이다 (FR-B-5)', () => {
  assert.equal(i18n('en').html.lang, 'en');
  assert.equal(i18n(null).html.lang, 'ko');
});

test('apply: data-i18n 은 텍스트, data-i18n-title/placeholder/aria-label 은 속성을 채운다 (FR-B-2)', () => {
  const a = el({ i18n: 'html.btn' });
  const b = el({ i18nTitle: 'html.btn', i18nPlaceholder: 'html.btn', i18nAriaLabel: 'html.btn' });
  const en = i18n('en', { elements: [a, b] });
  en.I18N.apply(en.ctx.document);
  assert.equal(a.textContent, 'Button');
  assert.equal(b.attrs.title, 'Button');
  assert.equal(b.attrs.placeholder, 'Button');
  assert.equal(b.attrs['aria-label'], 'Button');
});

test('apply: data-i18n-shortcut 은 {key} 에 단축키 표기를 넣는다 (FR-B-7)', () => {
  const a = el({ i18nTitle: 'html.tip', i18nShortcut: 'splitH' });
  const en = i18n('en', { elements: [a] });
  en.I18N.apply(en.ctx.document, { shortcut: (action) => (action === 'splitH' ? '⌃⇧H' : '') });
  assert.equal(a.attrs.title, 'Help ⌃⇧H');
  // 재바인딩 뒤 다시 채우면 새 표기가 든다.
  en.I18N.apply(en.ctx.document, { shortcut: () => '⌃⇧J' });
  assert.equal(a.attrs.title, 'Help ⌃⇧J');
});

test('register: 같은 로케일에 두 번 등록하면 합쳐진다', () => {
  const ko = i18n('ko');
  ko.I18N.register('ko', { 'y.more': '더' });
  assert.equal(ko.t('y.more'), '더');
  assert.equal(ko.t('x.hello', { name: 'a' }), '안녕 a');
});

test('상수 셋이 정책과 같다 (FR-B-1)', () => {
  const k = i18n(null);
  assert.deepEqual([...k.ctx.I18N_LOCALES], ['ko', 'en']);
  assert.equal(k.ctx.I18N_DEFAULT, 'ko');
  assert.equal(k.ctx.I18N_STORAGE_KEY, 'dm.locale');
});
