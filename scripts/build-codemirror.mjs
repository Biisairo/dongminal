#!/usr/bin/env node
/**
 * CodeMirror 벤더 묶음을 만든다 — CODEMIRROR_MIGRATION_SRS 묶음 V.
 *
 * 입력: scripts/codemirror/ (entry.js · package.json · package-lock.json)
 * 출력: web/vendor/codemirror/ — `.gz` 만 (FR-CMR-2)
 *
 * 판을 올릴 때만 사람이 돌린다 (FR-CMR-4). build.sh 는 이 스크립트를 부르지 않는다 —
 * `go build` 에 Node 가 필요 없는 성질을 지킨다.
 *
 *   cd scripts/codemirror && npm ci
 *   node scripts/build-codemirror.mjs [--out <dir>]
 *
 * 같은 입력이면 출력 바이트가 같다. gzip 머리의 시각은 0 이고, 기계마다 달라지는
 * OS 바이트는 255(unknown)로 고정한다.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = path.join(ROOT, 'scripts/codemirror');
const DEFAULT_OUT = path.join(ROOT, 'web/vendor/codemirror');
const ENTRY_NAME = 'cm';
const LICENSE_FILE = 'THIRD_PARTY_LICENSES.txt';
const GZIP_OS_BYTE = 9;
const GZIP_OS_UNKNOWN = 255;
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE'];

function parseOut(argv) {
  const i = argv.indexOf('--out');
  if (i < 0) return DEFAULT_OUT;
  if (!argv[i + 1]) {
    console.error('--out 뒤에 디렉터리가 필요하다');
    process.exit(2);
  }
  return path.resolve(argv[i + 1]);
}

function gzip(buf) {
  const gz = zlib.gzipSync(buf, { level: 9 });
  gz[GZIP_OS_BYTE] = GZIP_OS_UNKNOWN;
  return gz;
}

// metafile 의 입력 경로에서 패키지 이름을 뽑는다. scope 가 있으면 두 마디다.
function packageOf(input) {
  const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  return m ? m[1] : null;
}

function licenseText(pkgDir) {
  for (const n of LICENSE_NAMES) {
    const p = path.join(pkgDir, n);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  return null;
}

// FR-CMR-5a: 묶음에 실제로 들어간 패키지의 라이선스만 모은다.
function collectLicenses(metafile) {
  const pkgs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const p = packageOf(input);
    if (p) pkgs.add(p);
  }
  const parts = [];
  const missing = [];
  for (const name of [...pkgs].sort()) {
    const dir = path.join(INPUT, 'node_modules', name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const text = licenseText(dir);
    if (!text) missing.push(name);
    parts.push(`## ${name}@${meta.version} (${meta.license || 'UNKNOWN'})\n\n${text || '(LICENSE 파일 없음)'}\n`);
  }
  if (missing.length) {
    console.error(`LICENSE 파일이 없는 패키지: ${missing.join(', ')}`);
    process.exit(1);
  }
  const head = '# web/vendor/codemirror — 묶인 제3자 패키지의 라이선스\n\n' +
    'scripts/build-codemirror.mjs 가 만든다. 손으로 고치지 않는다.\n\n';
  return head + parts.join('\n');
}

async function main() {
  const out = parseOut(process.argv.slice(2));
  const req = createRequire(path.join(INPUT, 'package.json'));
  if (!fs.existsSync(path.join(INPUT, 'node_modules'))) {
    console.error('묶음 입력이 설치돼 있지 않다 — `cd scripts/codemirror && npm ci`');
    process.exit(1);
  }
  const esbuild = req('esbuild');
  const result = await esbuild.build({
    entryPoints: { [ENTRY_NAME]: path.join(INPUT, 'entry.js') },
    absWorkingDir: INPUT,
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    target: 'es2020',
    legalComments: 'none',
    chunkNames: '[name]-[hash]',
    outdir: out,
    write: false,
    metafile: true,
    logLevel: 'warning',
  });

  // 낡은 청크가 남지 않게 출력은 비우고 다시 쓴다.
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let raw = 0;
  let packed = 0;
  for (const f of result.outputFiles) {
    const gz = gzip(f.contents);
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path + '.gz', gz);
    raw += f.contents.length;
    packed += gz.length;
  }
  fs.writeFileSync(path.join(out, LICENSE_FILE + '.gz'), gzip(Buffer.from(collectLicenses(result.metafile))));
  console.log(`${result.outputFiles.length + 1} files → ${path.relative(ROOT, out) || out} (raw ${raw}, gz ${packed})`);
}

await main();
