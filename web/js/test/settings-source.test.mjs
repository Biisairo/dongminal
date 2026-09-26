import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-4 (FEC-25 · FEC-M2) — 설정의 기본값·범위는
 * `SETTINGS_SCHEMA` 한 자리에서 온다 (TC-CFG-2x).
 *
 * 종전에는 같은 값이 표와 상수(`AGENTS_POLL_DEFAULT`·`TAB_WIDTH_*`·`UFE_LEVEL_*` …)에
 * 두 벌로 있었고, 검증기도 넷(`settingValue`·`clampSetting`·`pollValue`·`clampTabWidth`)이었다.
 * 두 벌이 같은지 보는 것은 아무것도 없었다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(JS, rel), 'utf8');

/** 파생 상수 → [표의 키, 필드]. */
const DERIVED = {
  AGENTS_POLL_DEFAULT: ['agentsPollInterval', 'def'],
  STATS_INTERVAL_DEFAULT: ['statsInterval', 'def'],
  GIT_STATUS_POLL_MS: ['gitStatusInterval', 'def'],
  GIT_REPOS_POLL_MS: ['gitReposInterval', 'def'],
  GIT_CON_POLL_MS: ['gitConsoleInterval', 'def'],
  TAB_WIDTH_DEFAULT: ['tabWidthPx', 'def'],
  TAB_WIDTH_MIN: ['tabWidthPx', 'min'],
  TAB_WIDTH_MAX: ['tabWidthPx', 'max'],
  UFE_LEVEL_DEFAULT: ['focusEdgeLevel', 'def'],
  UFE_LEVEL_MAX: ['focusEdgeLevel', 'max'],
  ATTN_EDGE_LEVEL_DEFAULT: ['attnEdgeLevel', 'def'],
  ATTN_EDGE_LEVEL_MAX: ['attnEdgeLevel', 'max'],
};

/** 표에서 초기값을 받는 설정 전역 → 표의 키. */
const VARS = {
  agentsPollInterval: 'agentsPollInterval', statsInterval: 'statsInterval',
  gitStatusInterval: 'gitStatusInterval', gitReposInterval: 'gitReposInterval',
  gitConsoleInterval: 'gitConsoleInterval', tabWidthPx: 'tabWidthPx',
  focusEdgeLevel: 'focusEdgeLevel', attnEdgeLevel: 'attnEdgeLevel',
};

const defaults = () => load(['core/settings-schema.js', 'core/settings-defaults.js'], {
  expose: ['SETTINGS_BY_KEY', ...Object.keys(DERIVED)],
});

test('TC-CFG-2x: 파생 상수가 표의 def·min·max 와 같다', () => {
  const c = defaults();
  for (const [name, [key, field]] of Object.entries(DERIVED)) {
    assert.equal(c[name], c.SETTINGS_BY_KEY[key][field], `${name} ≠ ${key}.${field}`);
  }
});

test('TC-CFG-2x: 설정 전역의 초기값이 표의 기본값이다', () => {
  const c = defaults();
  for (const [v, key] of Object.entries(VARS)) {
    assert.equal(c[v], c.SETTINGS_BY_KEY[key].def, `${v} 의 초기값`);
  }
});

/** 주석을 걷은 소스. 주석 안의 이름은 선언이 아니다. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function jsFiles(dir, out = []) {
  for (const e of readdirSync(join(JS, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) { if (!['test', 'i18n'].includes(e.name)) jsFiles(rel, out); continue; }
    if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

test('TC-CFG-2x: 파생 상수·설정 전역은 settings-defaults.js 에서만 선다', () => {
  const names = [...Object.keys(DERIVED), ...Object.keys(VARS)];
  for (const rel of [...jsFiles('core'), ...jsFiles('ui'), ...jsFiles('git')]) {
    if (rel === 'core/settings-defaults.js') continue;
    const src = code(read(rel));
    for (const n of names) {
      assert.doesNotMatch(src, new RegExp(`(^|[;\\s])(const|let|var)\\s+${n}\\b`, 'm'), `${rel} 가 ${n} 를 다시 선언한다`);
    }
  }
  const own = code(read('core/settings-defaults.js'));
  for (const n of Object.keys(DERIVED)) {
    assert.match(own, new RegExp(`const\\s+${n}\\s*=\\s*SETTINGS_BY_KEY\\.`), `${n} 가 표에서 파생되지 않는다`);
  }
});

test('FR-OPT-11-4: 검증기는 표 위의 것만 남는다 (pollValue·clampTabWidth 폐기)', () => {
  for (const rel of [...jsFiles('core'), ...jsFiles('ui'), ...jsFiles('git')]) {
    const src = code(read(rel));
    assert.doesNotMatch(src, /\bpollValue\b/, `${rel} 가 pollValue 를 쓴다`);
    assert.doesNotMatch(src, /\bclampTabWidth\b/, `${rel} 가 clampTabWidth 를 쓴다`);
  }
});

test('FR-OPT-11-4: 주기 선택지의 최소·최대가 표의 min·max 와 같다', () => {
  const c = load(['core/settings-schema.js', 'core/app-polling.js'], {
    expose: ['POLL_SETTINGS', 'SETTINGS_BY_KEY'],
    globals: { App: function App() {}, t: (k) => k, tn: (k, n) => k + n },
  });
  for (const spec of c.POLL_SETTINGS) {
    const s = c.SETTINGS_BY_KEY[spec.key];
    const vals = spec.opts.map((o) => o[0]).filter((v) => v > 0);
    assert.equal(Math.min(...vals), s.min, spec.key + ' 최소');
    assert.equal(Math.max(...vals), s.max, spec.key + ' 최대');
    assert.equal(spec.opts.some((o) => o[0] === 0), !!s.off, spec.key + ' 끔');
  }
});

test('FR-OPT-11-4: 표가 상수보다 먼저 선다 (index.html 로드 순서)', () => {
  const html = read('../index.html');
  const order = [...html.matchAll(/<script\s+src="js\/([^"?]+)/g)].map((m) => m[1]);
  const at = (f) => { const i = order.indexOf(f); assert.notEqual(i, -1, f + ' 가 실리지 않는다'); return i };
  assert.equal(at('core/settings-defaults.js'), at('core/settings-schema.js') + 1);
  assert.ok(at('core/settings-defaults.js') < at('core/constants.js'));
});

test('FEC-M2: 스키마 주석이 실제로 있는 검사를 가리킨다', () => {
  const src = read('core/settings-schema.js');
  assert.doesNotMatch(src, /어긋나면 `TC-CFG-2` 가 잡는다/);
  assert.match(src, /TC-CFG-2x/);
});
