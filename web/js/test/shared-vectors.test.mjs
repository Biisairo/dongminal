import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * SERVER_DRIVEN_ACTIONS_SRS K-j ⑤ — 값이 아니라 계산이라 서버가 보낼 수 없는 두 벌(K6·K16).
 * Go 시험과 **같은 표본**을 읽는다. 한쪽 계산만 바뀌면 둘 중 하나가 실패한다.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = (rel) => JSON.parse(readFileSync(join(HERE, '../../..', rel), 'utf8'));

test('K6: GitHistory._digest 는 서버 gitOidDigest 와 같은 값을 낸다', () => {
  const ctx = load(['git/history-load.js'], { globals: { GitHistory: function GitHistory() {} } });
  const vs = vectors('internal/webserver/gitapi/testdata/oid_digest_vectors.json');
  assert.ok(vs.length >= 3);
  for (const v of vs) {
    const cs = v.oids.map((oid) => ({ oid }));
    assert.equal(ctx.GitHistory.prototype._digest(cs), v.digest, JSON.stringify(v.oids));
  }
});

test('K16: 서버가 지우는 질의마다 그 응답을 화면이 보고로 안다', () => {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js'], { expose: ['TERM_REPORT_RE'] });
  const vs = vectors('internal/webserver/httpapi/testdata/term_query_report_vectors.json');
  assert.ok(vs.length >= 8);
  for (const v of vs) {
    assert.ok(ctx.TERM_REPORT_RE.test(v.report), `${v.name}: ${JSON.stringify(v.report)}`);
  }
});
