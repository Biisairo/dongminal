import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
