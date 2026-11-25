/**
 * 묶음 정의 `web/bundles.txt` 읽기 (PERF_OPTIMIZATION_SRS D-29·D-33).
 *
 * 서버(`rust/crates/webserver/httpapi/src/bundles.rs`)가 이 정의대로 `/b/<이름>.js` 를 이어 붙인다.
 * 형식 규칙은 서버와 같고, 여기서는 한 파일을 두 묶음에 두는 것도 막는다.
 *
 *   parseBundles(text)       이름 → { js, css }. 어긋나면 던진다
 *   readBundles(root)        저장소 뿌리에서 정의를 읽는다
 *   pageScripts(html, defs)  index.html 이 싣는 `js/…` 를 페이지 순서로. `b/<이름>.js` 는 펼친다
 *   loadOrder(html, defs)    페이지 순서 + 페이지가 싣지 않은 묶음(정의 순서)
 *   repoLoadOrder(root)      저장소의 index.html 과 정의로 본 loadOrder
 *   cssProblems(src)         묶음 CSS 가 쓰면 안 되는 것(상대 url()·@import). 서버가 `/b/` 아래에서 내므로 상대 경로가 깨진다
 *   registryProblems(js, defs) `Screens.register(이름, {bundle, css})` 가 정의의 묶음·CSS 유무와 맞는가
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLES_DEF = 'web/bundles.txt';

export function parseBundles(text) {
  const out = new Map();
  const owner = new Map();
  let cur = null;
  const fail = (n, why) => { throw new Error(`bundles.txt:${n}: ${why}`); };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (!line || line.startsWith('#')) return;
    const sec = line.match(/^\[(.*)\]$/);
    if (sec) {
      if (!sec[1] || out.has(sec[1])) fail(n, `묶음 이름이 비었거나 겹친다: ${line}`);
      cur = { js: [], css: [] };
      out.set(sec[1], cur);
      return;
    }
    if (!cur) fail(n, `묶음 밖의 줄: ${line}`);
    const kind = line.endsWith('.js') ? 'js' : line.endsWith('.css') ? 'css' : fail(n, `.js·.css 가 아니다: ${line}`);
    if (owner.has(line)) fail(n, `${line} 가 이미 [${owner.get(line)}] 에 있다`);
    owner.set(line, [...out.keys()].pop());
    cur[kind].push(line);
  });
  return out;
}

export function readBundles(root) {
  return parseBundles(readFileSync(join(root, BUNDLES_DEF), 'utf8'));
}

export function pageScripts(html, defs) {
  const out = [];
  for (const m of html.matchAll(/<script\s+src="([^"?]+)/g)) {
    const src = m[1];
    const b = src.match(/^b\/([^/]+)\.js$/);
    if (b) {
      if (!defs.has(b[1])) throw new Error(`index.html 이 정의에 없는 묶음을 싣는다: ${src}`);
      out.push(...defs.get(b[1]).js);
    } else if (src.startsWith('js/')) {
      out.push(src);
    }
  }
  const seen = new Set();
  for (const f of out) {
    if (seen.has(f)) throw new Error(`${f} 를 두 번 싣는다 (태그와 묶음 또는 묶음 둘)`);
    seen.add(f);
  }
  return out;
}

export function repoLoadOrder(root) {
  return loadOrder(readFileSync(join(root, 'web', 'index.html'), 'utf8'), readBundles(root));
}

export function loadOrder(html, defs) {
  const page = pageScripts(html, defs);
  const inPage = new Set(html.matchAll(/<script\s+src="b\/([^/"?]+)\.js/g).map((m) => m[1]));
  const rest = [...defs].filter(([name]) => !inPage.has(name)).flatMap(([, d]) => d.js);
  return [...page, ...rest];
}

export function cssProblems(src) {
  const out = [];
  if (/@import\b/.test(src)) out.push('@import');
  for (const m of src.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g)) {
    if (!/^(data:|\/|#)/.test(m[2])) out.push(m[0]);
  }
  return out;
}

export function registryProblems(js, defs) {
  const out = [];
  for (const m of js.matchAll(/Screens\.register\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
    const bundle = (m[2].match(/\bbundle\s*:\s*'([^']+)'/) || [])[1] || m[1];
    const css = /\bcss\s*:\s*true\b/.test(m[2]);
    const d = defs.get(bundle);
    if (!d) out.push(`${m[1]}: 정의에 없는 묶음 ${bundle}`);
    else if (css !== d.css.length > 0) out.push(`${m[1]}: css 표시(${css})가 [${bundle}] 의 CSS 줄 수(${d.css.length})와 어긋난다`);
  }
  return out;
}
