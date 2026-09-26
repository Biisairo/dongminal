import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isolationPortBase } from '../e2e-isolate-flaky.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-16-4: `make e2e` 의 포트 뿌리를 `E2E_PORT_BASE` 로 받는다.
 *
 * 진짜 playwright 대신 `npx` 대역을 PATH 앞에 둔다 — 대역은 받은 `E2E_PORT_BASE` 만 찍는다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = process.platform === 'win32' ? 'bash 스크립트다' : false;

function shardPort(i, env) {
  const bin = mkdtempSync(join(tmpdir(), 'dm-shard-run-'));
  try {
    const npx = join(bin, 'npx');
    writeFileSync(npx, '#!/bin/sh\necho "PORT=$E2E_PORT_BASE"\n');
    chmodSync(npx, 0o755);
    const base = { ...process.env, PATH: bin + ':' + process.env.PATH };
    delete base.E2E_PORT_BASE;
    const r = spawnSync('bash', [join(ROOT, 'scripts/e2e-shard-run.sh'), String(i), '8'], {
      env: { ...base, ...env }, encoding: 'utf8',
    });
    const m = /PORT=(\d+)/.exec(r.stdout);
    return { status: r.status, port: m ? Number(m[1]) : null, out: r.stdout + r.stderr };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test('기본 뿌리는 58147 이고 샤드마다 10 씩 옮긴다', { skip }, () => {
  assert.equal(shardPort(1, {}).port, 58147);
  assert.equal(shardPort(3, {}).port, 58167);
});

test('E2E_PORT_BASE 가 뿌리를 옮긴다', { skip }, () => {
  const r = shardPort(2, { E2E_PORT_BASE: '60500' });
  assert.equal(r.port, 60510, r.out);
});

test('운영 포트 58146 을 덮는 뿌리는 거절한다', { skip }, () => {
  const r = shardPort(1, { E2E_PORT_BASE: '58100' });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.port, null, '거절했는데 playwright 를 불렀다');
});

test('격리 재실행 대역도 뿌리를 따른다 (기본 59000)', () => {
  assert.equal(isolationPortBase({}), 59000);
  assert.equal(isolationPortBase({ E2E_PORT_BASE: '60500' }), 60500 + (59000 - 58147));
});
