import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * BROWSER_TAB_SRS TC-BRT-51 — 링크 클릭의 네 출처가 한 길(`app.openLink`)을 지난다. 그 길의
 * 설정 × 수정키 표는 e2e(TC-BRT-51·52)가 잰다. 여기서는 출처가 그 길을 비켜 가지 않는지를 본다.
 */
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

test('터미널·문서·업데이트 알림의 링크는 app.openLink 로 간다', () => {
  for (const f of ['js/ui/term-pane.js', 'js/ui/doc-render.js', 'js/core/app-update.js']) {
    assert.match(read(f), /\.openLink\(/, f);
  }
});

test('편집기(Monaco)의 링크 열기는 browserLinkOpenerInstall 로 갈아 끼운다', () => {
  assert.match(read('js/ui/file-editor.js'), /browserLinkOpenerInstall\(\)/);
  assert.match(read('js/core/app-browser.js'), /function browserLinkOpenerInstall\(/);
});
