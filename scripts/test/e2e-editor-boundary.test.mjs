import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * CODEMIRROR_MIGRATION_SRS FR-CMR-121 — **편집 엔진을 아는 e2e 코드는 `e2e/editor.ts` 하나다.**
 *
 * 스펙이 엔진 전역·엔진 DOM 클래스·엔진 핸들 필드를 직접 쓰면, 엔진을 바꾸는 날 그 스펙이
 * 조용히 깨지거나(선택자) 엉뚱한 것을 잰다(필드). 고칠 자리를 어댑터 하나로 지킨다.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const E2E = path.join(root, 'e2e');
const ADAPTER = 'editor.ts';

const FORBIDDEN = [
  { re: /\bmonaco\s*\.|\(window as any\)\.monaco\b|\bwindow\.monaco\b/, why: '엔진 전역' },
  { re: /\.monaco-[a-z]/, why: '엔진 DOM 클래스' },
  { re: /\._editor\b/, why: '칸의 엔진 핸들 필드' },
  { re: /\._(?:mod|orig)\b/, why: 'Diff 의 엔진 문서 필드' },
  { re: /\.model\s*\.|\.model\s*\?\.|\.model\s*===|!!\s*\S*\.model\b/, why: '문서 레지스트리의 엔진 문서' },
];

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

test('FR-CMR-121: e2e 스펙은 엔진에 직접 닿지 않는다 (어댑터 밖 0곳)', () => {
  const hits = [];
  for (const name of fs.readdirSync(E2E)) {
    if (!name.endsWith('.ts') || name === ADAPTER) continue;
    const lines = fs.readFileSync(path.join(E2E, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      for (const f of FORBIDDEN) {
        if (f.re.test(line)) hits.push(`${name}:${i + 1} (${f.why}) ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `어댑터를 거치지 않은 자리:\n${hits.join('\n')}`);
});

test('FR-CMR-121: 어댑터가 모든 페이지에 심긴다', () => {
  const fx = fs.readFileSync(path.join(E2E, 'fixtures.ts'), 'utf8');
  assert.match(fx, /context\.addInitScript\(installEdAdapter, ED_SEL\)/);
});

test('FR-CMR-121 실패 경로: 금지 패턴이 실제로 잡힌다', () => {
  const samples = [
    "(window as any).monaco.editor.getEditors()",
    "page.locator('.monaco-editor')",
    'v._editor.getValue()',
    'dv._mod.getValue()',
    'd.model.getValue()',
  ];
  for (const s of samples) {
    assert.ok(FORBIDDEN.some((f) => f.re.test(s)), `잡히지 않았다: ${s}`);
  }
  assert.ok(!FORBIDDEN.some((f) => f.re.test("const ROOT = tmpPath('dm-monaco-offline-')")));
});
