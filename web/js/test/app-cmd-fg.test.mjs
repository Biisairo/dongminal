import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-5 후속 (Ofix2): 전경 이름은 `_onWorkspaceChanged` 가 연
 * `fg` 비행 안에서만 얹는다. 워크스페이스 적용기(`_applyRemoteWorkspace`)의 `fgTouched`
 * 갈래는 부르는 두 자리(`false`·`toolsKnown=false`)가 모두 건너뛰어 죽은 코드였다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(JS, f), 'utf8');

function body(s, head) {
  const i = s.indexOf(head);
  assert.ok(i >= 0, head + ' 가 있다');
  return s.slice(i, s.indexOf('\n  },', i));
}

test('_applyRemoteWorkspace 는 전경 이름을 얹지 않는다 — fgTouched 매개변수가 없다', () => {
  const b = body(src('core/app-cmd.js'), '  _applyRemoteWorkspace(');
  assert.match(b, /^ {2}_applyRemoteWorkspace\(sv, serverPanes, toolsKnown\)\{/);
  assert.doesNotMatch(b, /this\._fgApply\(/);
});

test('부르는 자리는 네 번째 인자를 싣지 않는다', () => {
  for (const f of ['core/app-cmd.js', 'core/app.js']) {
    for (const m of src(f).matchAll(/this\._applyRemoteWorkspace\(([^)]*)\)/g)) {
      assert.ok(m[1].split(',').length <= 3, f + ': ' + m[0]);
    }
  }
});
