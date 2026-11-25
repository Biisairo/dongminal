import { readFileSync } from 'fs';
import { join } from 'path';

import * as espree from 'espree';

import { test, expect } from './fixtures';

// PERF 3.4.10 — 서버는 묶음의 주석·줄 끝 공백을 걷는다 (D-35). 걷은 묶음은 원본 이음과 토큰 열이 같고 줄 수가 같다.

const WEB = join(__dirname, '..', 'web');

function bundleDefs(): Map<string, string[]> {
  const defs = new Map<string, string[]>();
  let cur: string[] = [];
  for (const raw of readFileSync(join(WEB, 'bundles.txt'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) defs.set(m[1], (cur = []));
    else if (line.endsWith('.js')) cur.push(line);
  }
  return defs;
}

function joined(name: string, files: string[]): string {
  let out = '';
  for (const f of files) {
    const src = readFileSync(join(WEB, f), 'utf8');
    out += `/* ==== ${f} ==== */\n${src}${src.endsWith('\n') ? '' : '\n'}`;
  }
  return `${out}//# sourceMappingURL=${name}.js.map\n`;
}

type Parsed = ReturnType<typeof espree.parse> & { comments: { value: string }[] };

const tokens = (src: string) =>
  espree.tokenize(src, { ecmaVersion: 'latest', sourceType: 'script' }).map((t: { type: string; value: string }) => `${t.type}:${t.value}`);

test('TC-BST-1: 걷은 묶음마다 원본 이음과 토큰 열·줄 수가 같고, 주석은 남지 않는다', async ({ request }) => {
  const defs = bundleDefs();
  expect(defs.has('boot')).toBe(true);
  for (const [name, files] of defs) {
    if (!files.length) continue;
    const res = await request.get(`/b/${name}.js`);
    expect(res.status(), name).toBe(200);
    const got = await res.text();
    const want = joined(name, files);
    expect(got.split('\n').length, name).toBe(want.split('\n').length);
    expect(tokens(got), name).toEqual(tokens(want));
    expect(got.length, name).toBeLessThan(want.length);
    const ast = espree.parse(got, { ecmaVersion: 'latest', sourceType: 'script', comment: true }) as Parsed;
    const left = ast.comments
      .map((c) => c.value)
      .filter((v: string) => !/^ ==== .+ ==== $/.test(v) && !v.startsWith('!') && !v.startsWith('# sourceMappingURL='));
    expect(left, name).toEqual([]);
  }
});
