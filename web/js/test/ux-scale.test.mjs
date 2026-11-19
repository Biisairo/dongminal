import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-44 (FR-UXF-44·45) · TC-UXF-45 의 unit 부분 (FR-UXF-46).
 *
 * `--fs-xs`(9px)는 기호 자리에만 남는다. `var(--fs-xs)` 를 쓰는 선언의 선택자를 모아
 * §3.6.1 의 남는 자리 표와 대조한다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');

/** §3.6.1 남는 자리(기호). 선택자에 이 중 하나가 들어 있으면 기호 자리다. */
const GLYPH_SITES = [
  '.sb-tab-badge', '.ag-tab-n', '.ui-tab-badge', '.git-hist-opts-badge',
  '.ed-tw', '.git-br-twist',
  '.eg-mesh-mark',
];

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const cssFiles = () => readdirSync(WEB).filter((f) => f.endsWith('.css')).map((f) => join(WEB, f));

/** 가장 안쪽 규칙 블록마다 `{ selector, body }` 를 낸다. */
function rules(src) {
  const out = [];
  for (const m of strip(src).matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

test('TC-UXF-44: var(--fs-xs) 는 기호 자리에만 쓴다 (FR-UXF-44·45)', () => {
  const outside = [];
  let seen = 0;
  for (const f of cssFiles()) {
    for (const r of rules(readFileSync(f, 'utf8'))) {
      for (const d of r.body.split(';')) {
        if (!d.includes('var(--fs-xs)')) continue;
        seen++;
        const prop = d.split(':')[0].trim();
        if (prop === '--sb-rail-fs') continue; // 레일 글자 (§3.6.1)
        if (GLYPH_SITES.some((s) => r.selector.includes(s))) continue;
        outside.push(`${f.split('/').pop()}  ${r.selector} { ${d.trim()} }`);
      }
    }
  }
  assert.ok(seen >= 5, `var(--fs-xs) 선언을 ${seen}개밖에 못 읽었다 — 검사가 공회전한다`);
  assert.deepEqual(outside, [], `기호 자리 밖에서 --fs-xs 를 쓴다 — 읽는 글은 --fs-sm 이다:\n${outside.join('\n')}`);
});

test('TC-UXF-45: 모서리 토큰 넷과 --ui-radius 의 가리킴 (FR-UXF-46)', () => {
  const root = strip(readFileSync(join(WEB, 'style.css'), 'utf8'));
  const want = { '--radius-sm': '4px', '--radius-md': '6px', '--radius-lg': '8px', '--radius-pill': '999px' };
  for (const [k, v] of Object.entries(want)) {
    const m = root.match(new RegExp(`${k}\\s*:\\s*([^;}]+)`));
    assert.ok(m, `${k} 정의가 없다`);
    assert.equal(m[1].trim(), v, `${k} 값`);
  }
  const kit = strip(readFileSync(join(WEB, 'style-kit.css'), 'utf8'));
  const ui = kit.match(/--ui-radius\s*:\s*([^;}]+)/);
  assert.ok(ui, '--ui-radius 정의가 없다');
  assert.equal(ui[1].trim(), 'var(--radius-sm)', '--ui-radius 는 --radius-sm 을 가리킨다');
});
