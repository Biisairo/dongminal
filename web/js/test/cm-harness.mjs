import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

/**
 * 커밋된 CodeMirror 벤더 묶음을 Node 에서 불러온다 (CODEMIRROR_MIGRATION_SRS §11.1).
 *
 * `web/vendor/codemirror` 는 `.gz` 로만 담겨 있다(FR-CMR-2). 임시 디렉터리에 풀어 `cm.js` 를
 * `import` 한다 — CI 에서 따로 설치하지 않고, **배포되는 바이트를 그대로** 잰다.
 * 프로세스 안에서 한 번만 푼다.
 */

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/codemirror');

let loading = null;

export function loadCM() {
  if (loading) return loading;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-vendor-'));
  for (const name of fs.readdirSync(VENDOR)) {
    if (!name.endsWith('.js.gz')) continue;
    fs.writeFileSync(path.join(dir, name.slice(0, -3)), zlib.gunzipSync(fs.readFileSync(path.join(VENDOR, name))));
  }
  loading = import(pathToFileURL(path.join(dir, 'cm.js')).href);
  return loading;
}
