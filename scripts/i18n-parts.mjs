/**
 * 언어 카탈로그 조각의 규칙 (PERF_OPTIMIZATION_SRS D-46, perf/M3_BOOT_SCOPE.md §3).
 *
 * 부팅 카탈로그 `web/js/i18n/<로케일>.js` 는 첫 화면이 쓰는 키를 든다. 지연 묶음 하나에서만 쓰는 키는
 * 조각 `web/js/i18n/<묶음>.<로케일>.js` 로 가고, `Screens.load` 가 그 묶음 JS 앞에 싣는다(`i18n:true` 등록).
 *
 * 키가 "쓰이는 곳" 은 `check-i18n` 의 미사용 판정과 같은 근거다 — 키와 같은 문자열 리터럴이 든 파일의 묶음,
 * index.html(`'html'`). 동적 접두로 조립하는 키는 어디서 쓰일지 알 수 없으므로 부팅에 남는다.
 *
 *   partFile(name)        `git.ko.js` → { bundle, locale }. 조각이 아니면 null
 *   i18nFlagged(js)       `Screens.register(…, {i18n:true})` 의 묶음 이름들
 *   partProblems(input)   위반 목록(빈 배열이면 통과)
 */
export const PART_LOCALES = ['ko', 'en'];
const BOOT_PLACES = new Set(['pre', 'boot', 'html']);

export function partFile(name) {
  const m = name.match(/^([a-z0-9_-]+)\.([a-z]+)\.js$/);
  return m && PART_LOCALES.includes(m[2]) ? { bundle: m[1], locale: m[2] } : null;
}

export function i18nFlagged(js) {
  const out = new Set();
  for (const m of js.matchAll(/Screens\.register\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
    if (/\bi18n\s*:\s*true\b/.test(m[2])) out.add((m[2].match(/\bbundle\s*:\s*'([^']+)'/) || [])[1] || m[1]);
  }
  return out;
}

const baseKey = (k) => k.replace(/\.(other|one)$/, '');
/** 복수형의 `.one` 은 언어의 것이다 — ko 는 `.other` 만 둔다. */
const pluralOne = (k, set) => k.endsWith('.one') && set.has(k.slice(0, -4) + '.other');

/**
 * @param {object} input
 * @param {{ko:string[], en:string[]}} input.base 부팅 카탈로그의 키
 * @param {Map<string,{ko:string[]|null, en:string[]|null}>} input.parts 묶음 → 조각 키
 * @param {(key:string)=>Set<string>} input.places 키가 쓰이는 곳(묶음 이름·'html')
 * @param {(key:string)=>boolean} input.dynamic 동적 접두로 조립되는 키인가
 * @param {Set<string>} input.bundles bundles.txt 의 묶음 이름
 * @param {Set<string>} input.flagged `i18n:true` 로 등록한 묶음
 * @param {Set<string>} input.unfragmented 조각 없이 키를 부팅에 두는 묶음(사유는 호출자가 진다)
 */
export function partProblems({ base, parts, places, dynamic, bundles, flagged, unfragmented }) {
  const out = [];
  const seen = new Map();
  for (const l of PART_LOCALES) for (const k of base[l]) seen.set(l + ':' + k, 'boot');

  for (const [b, p] of parts) {
    const where = `web/js/i18n/${b}.<locale>.js`;
    if (!bundles.has(b) || BOOT_PLACES.has(b)) out.push(`${where}: 지연 묶음이 아니다 — bundles.txt 의 지연 묶음 이름이어야 한다`);
    if (!flagged.has(b)) out.push(`${where}: [${b}] 를 Screens.register(…, {i18n:true}) 로 등록하지 않아 조각이 실리지 않는다`);
    for (const l of PART_LOCALES) if (!p[l]) out.push(`${where}: ${l} 조각이 없다 — ko·en 을 함께 둔다`);
    if (!p.ko || !p.en) continue;
    const ko = new Set(p.ko), en = new Set(p.en);
    for (const k of ko) if (!en.has(k)) out.push(`web/js/i18n/${b}.en.js: ko 에만 있는 키: ${k}`);
    for (const k of en) if (!ko.has(k) && !pluralOne(k, ko)) out.push(`web/js/i18n/${b}.ko.js: en 에만 있는 키: ${k}`);
    for (const l of PART_LOCALES) {
      for (const k of p[l]) {
        const prev = seen.get(l + ':' + k);
        if (prev) out.push(`web/js/i18n/${b}.${l}.js: 키가 겹친다(${prev}): ${k}`);
        seen.set(l + ':' + k, b);
      }
    }
    for (const k of p.ko) {
      const at = [...places(baseKey(k))];
      if (dynamic(k)) out.push(`web/js/i18n/${b}.ko.js: 동적 접두로 조립되는 키는 부팅 카탈로그에 둔다: ${k}`);
      else if (at.length !== 1 || at[0] !== b) out.push(`web/js/i18n/${b}.ko.js: [${b}] 밖에서도 쓰이는 키다(${at.join(', ') || '쓰는 곳 없음'}): ${k}`);
    }
  }
  for (const b of flagged) if (!parts.has(b)) out.push(`[${b}]: i18n:true 로 등록했는데 조각 web/js/i18n/${b}.<locale>.js 가 없다`);

  for (const k of base.ko) {
    if (dynamic(k)) continue;
    const at = [...places(baseKey(k))];
    if (at.length === 1 && bundles.has(at[0]) && !BOOT_PLACES.has(at[0]) && !unfragmented.has(at[0])) {
      out.push(`web/js/i18n/ko.js: [${at[0]}] 에서만 쓰는 키는 조각 web/js/i18n/${at[0]}.<locale>.js 로 옮긴다: ${k}`);
    }
  }
  return out;
}
