import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * REFACTOR3_FE_REST2_SRS FR-FR2-13~15 · TC-FR2-5 (FC-19·20·22): 초 환산·타이밍·툴팁은 이름으로 쓴다.
 * 세는 범위는 `web/js/{core,ui,git}` 이다(`i18n`·`vendor` 밖). 남긴 것은 D-FR2-11·13 의 자리다.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function lines() {
  const out = [];
  for (const d of ['core', 'ui', 'git']) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const f = relative(ROOT, p);
          readFileSync(p, 'utf8').split('\n').forEach((l, i) => out.push({ f, n: i + 1, l }));
        }
      }
    };
    walk(join(ROOT, d));
  }
  return out;
}
const hits = (re, allow = () => false) => lines().filter((x) => re.test(x.l) && !allow(x)).map((x) => `${x.f}:${x.n}`);
const isConstFile = (f) => /^core\/constants[^/]*\.js$/.test(f);

test('TC-FR2-5: 초 ↔ 밀리초 환산은 MS_PER_SEC 를 쓴다', () => {
  // D-FR2-11: 등록부만 싣는 페이지에서도 정의돼야 하는 `CLAUDE_ACCT_POLL_MS`.
  assert.deepEqual(hits(/[*/] ?1000\b|1000 ?\*/, (x) => x.f === 'core/state-registry.js' && x.l.includes('CLAUDE_ACCT_POLL_MS')), []);
});

test('TC-FR2-5: 타이밍 상수는 constants*.js 에 있다', () => {
  const allow = (x) => isConstFile(x.f)
    || x.f === 'core/settings-defaults.js'                                   // 설정 표에서 파생 (FR-OPT-11-4)
    || (x.f === 'core/state-registry.js' && x.l.includes('CLAUDE_ACCT_POLL_MS')) // D-FR2-11
    || x.f === 'ui/diag.js';                                                 // D-FR2-13
  assert.deepEqual(hits(/^\s*(const|let)\s+[A-Z][A-Z0-9_]*_(MS|SEC)\s*=/, allow), []);
});

test('TC-FR2-5: 지연은 숫자 리터럴로 쓰지 않는다 (0 은 다음 차례라 뺀다)', () => {
  const re = /\b(after|setTimeout|setInterval)\(\s*[1-9]\d*\s*,|\b(setTimeout|setInterval)\([^;]*,\s*[1-9]\d*\s*\)|\)\s*\+\s*[1-9]\d*\s*,\s*\(\)\s*=>/;
  assert.deepEqual(hits(re), []);
});

test('TC-FR2-5: 코드 안 툴팁 리터럴은 TIP_* 로 간다', () => {
  const re = /\.title\s*=\s*['"`]|title:\s*['"`][A-Za-z]|setAttribute\(\s*['"]title['"]\s*,\s*['"`]|\btitle="[A-Za-z]|tip:\s*['"`][A-Za-z]/;
  // D-FR2-13: 서술자 표(상수 파일·사이드바 탭)와 진단 오버레이.
  const allow = (x) => isConstFile(x.f) || ['ui/sidebar-tabs.js', 'ui/sidebar-tab-chat.js', 'ui/diag.js'].includes(x.f);
  assert.deepEqual(hits(re, allow), []);
});

/** REFACTOR3_FE_REST2_SRS FR-FR2-12 · TC-FR2-5 (FU-19): 모달 폭은 CSS 클래스(`ui-modal-sm·md·lg`)다. */
test('TC-FR2-5: 모달 폭을 JS 문자열로 박지 않는다', () => {
  assert.deepEqual(hits(/width\s*:\s*['"`]min\(/), []);
  assert.ok(!/\bs\.width\b/.test(readFileSync(join(ROOT, 'ui/kit-modal.js'), 'utf8')), 'KitModal 에 width 선택지가 없다');
  const css = readFileSync(join(ROOT, '..', 'style-kit.css'), 'utf8');
  for (const [c, w] of [['sm', 420], ['md', 460], ['lg', 520]]) {
    assert.ok(css.includes(`.ui-modal-box.ui-modal-${c}{width:min(${w}px,90vw)}`), c);
  }
});
