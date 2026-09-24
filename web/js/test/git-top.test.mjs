import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-4 (F-3) — 저장소 최상위는 **요청 루트에서 어휘적으로** 계산한다.
 *
 * 서버의 `repo` 는 심볼릭 링크를 푼 값이라 편집기 경로와 다를 수 있다 — 그 값으로
 * 열면 같은 파일에 문서가 둘 생긴다(03 문서 키가 경로 문자열).
 */
const { gitRepoPrefix, gitLexicalTop } = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/helpers.js', 'core/git-path.js']);

test('접두: 저장소 루트에서 요청 루트까지 — 탐색기·변경 표시와 같은 규약', () => {
  assert.equal(gitRepoPrefix('/r/app', '/r/app'), '');
  assert.equal(gitRepoPrefix('/r/app', '/r/app/src/ui'), 'src/ui/');
  assert.equal(gitRepoPrefix('/r/app/', '/r/app/src'), 'src/');
  assert.equal(gitRepoPrefix('/r/app', '/r/appx/src'), null, '형제는 하위가 아니다');
  assert.equal(gitRepoPrefix('/r/app', ''), null);
  assert.equal(gitRepoPrefix('C:\\r\\app', 'C:\\r\\app\\src'), 'src/');
});

test('어휘적 최상위: 루트면 요청 그대로', () => {
  assert.equal(gitLexicalTop({ repo: '/r/app', requested: '/r/app', rootMatch: true, requestedResolved: '/r/app' }), '/r/app');
});

test('어휘적 최상위: 하위 폴더 루트는 접두만큼 올라간다', () => {
  assert.equal(gitLexicalTop({ repo: '/r/app', requested: '/r/app/src/ui', rootMatch: false, requestedResolved: '/r/app/src/ui' }), '/r/app');
  assert.equal(gitLexicalTop({ repo: '/r/app', requested: '/r/app/src/', rootMatch: false, requestedResolved: '/r/app/src' }), '/r/app');
});

test('어휘적 최상위: 심링크 루트는 서버가 푼 값이 아니라 요청한 쪽의 경로다', () => {
  // /tmp → /private/tmp (macOS 실측과 같은 모양)
  assert.equal(gitLexicalTop({ repo: '/private/tmp/app', requested: '/tmp/app', rootMatch: false, requestedResolved: '/private/tmp/app' }), '/tmp/app');
  assert.equal(gitLexicalTop({ repo: '/private/tmp/app', requested: '/tmp/app/src', rootMatch: false, requestedResolved: '/private/tmp/app/src' }), '/tmp/app');
});

test('어휘적 최상위: Windows 경로', () => {
  assert.equal(gitLexicalTop({ repo: 'C:\\r\\app', requested: 'C:\\r\\app\\src', rootMatch: false, requestedResolved: 'C:\\r\\app\\src' }), 'C:\\r\\app');
});

test('어휘적 최상위: 계산할 근거가 없으면 서버의 repo, 응답이 없으면 빈 값', () => {
  assert.equal(gitLexicalTop({ repo: '/r/app', requested: '/elsewhere', rootMatch: false, requestedResolved: '/elsewhere' }), '/r/app');
  assert.equal(gitLexicalTop({ repo: '/r/app', requested: '/r/app' }), '/r/app', '옛 서버(rootMatch 없음)');
  assert.equal(gitLexicalTop(null), '');
  assert.equal(gitLexicalTop({ isRepo: false, repo: '' }), '');
});
