import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELPERS, load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): helpers.js 는 주제별 파일로 갈렸다.
 * index.html 은 그 파일들을 옛 helpers.js 자리에 같은 순서로 싣는다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(JS, '..', 'index.html'), 'utf8');
const lines = (f) => readFileSync(join(JS, f), 'utf8').split('\n').length;

const HELPER_FILES = HELPERS;

test('주제 파일이 있고 helpers.js 는 작다', () => {
  for (const f of HELPER_FILES) assert.ok(existsSync(join(JS, f)), f);
  assert.ok(lines('core/helpers.js') < 250, 'helpers.js 가 ' + lines('core/helpers.js') + '줄이다');
});

test('index.html 이 주제 파일을 contrast.js 와 git-path.js 사이에 순서대로 싣는다', () => {
  const src = [...HTML.matchAll(/<script src="js\/([^"?]+)/g)].map((m) => m[1]);
  const i = src.indexOf('core/contrast.js');
  assert.deepEqual(src.slice(i + 1, i + 1 + HELPER_FILES.length), HELPER_FILES);
  assert.equal(src[i + 1 + HELPER_FILES.length], 'core/git-path.js');
});

test('주제 파일을 이어 실으면 옛 helpers.js 의 이름이 전부 선다', () => {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/settings-schema.js', 'core/settings-defaults.js',
    'core/constants.js', ...HELPER_FILES], { expose: ['SHORTCUT_DEFAULTS', 'TOOL_CAPABILITIES', 'TAB_NAME_DEFAULT', 'STATUS_ITEMS', 'UI_LABELS'] });
  for (const n of ['parseShortcut', 'pathJoin', 'escHtml', 'errText', 'statusRun', 'themeVarsOf', 'applyThemeObj',
    'applyTabWidth', 'normalizeLayout', 'panesOf', 'findTabWhere', 'mergeUnseenLayout', 'tabNameSource', 'tabName',
    'gitBadgeStale', 'visiblePoll', 'gitGroupEntries', 'gitSubParts', 'newUUID']) {
    assert.equal(typeof ctx[n], 'function', n);
  }
  assert.ok(ctx.SHORTCUT_DEFAULTS && ctx.TOOL_CAPABILITIES && ctx.STATUS_ITEMS && ctx.UI_LABELS);
  assert.equal(ctx.TAB_NAME_DEFAULT, 'Shell');
});
