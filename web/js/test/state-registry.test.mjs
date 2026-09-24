import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 02 §3A-2 — 서버가 넘친 구독을 **닫는다**. 그때 잃은 이벤트는 재연결의
 * 재수집이 되돌린다: 등록부의 `revalidateOn:['sse:open']` 가 그 약속이다. 새 코드
 * 없이 이 선언을 고정한다 — 누가 빼면 넘침 뒤 화면이 안전망까지 낡는다.
 */
test('재연결(sse:open)이 git·설정·포커스·도구 상태를 다시 받는다', () => {
  const ctx = load(['core/state-registry.js'], { expose: ['STATE_REGISTRY'] });
  const byId = new Map(ctx.STATE_REGISTRY.map((e) => [e.id, e]));
  for (const id of ['git.observe', 'settings', 'window.focus', 'tool.attention', 'tool.activity', 'tool.background']) {
    const e = byId.get(id);
    assert.ok(e, `${id} 선언이 없다`);
    assert.ok(e.revalidateOn.includes('sse:open'), `${id} 가 재연결에 다시 받지 않는다`);
  }
});
