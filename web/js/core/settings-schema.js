/**
 * 설정 블롭의 **서술자 표** — 키·타입·범위·기본값의 단일 원천
 * (CONFIG_MANAGEMENT_SRS 묶음 S, FR-CFG-1·2).
 *
 * 종전에는 같은 키 목록이 **세 곳**에 손으로 적혀 있었다 — `saveSettings` 의
 * PUT 본문 · `_settingsApply` 의 얹는 갈래 · `SETTINGS_PORTABILITY_SRS §3.1` 의
 * 이식 표. 그 계약의 집행자는 **사람의 눈**이었고, 빠뜨린 실패는 다른 브라우저
 * 창을 열어 보기 전까지 아무도 모른다.
 *
 * ── 이 파일의 형태가 계약이다 (FR-CFG-2) ─────────────────────────
 *
 * 아래는 `const SETTINGS_SCHEMA = <JSON 배열>;` **한 덩어리**이며 JS 표현식을
 * 쓰지 않는다. Go 가 embed 된 **같은 바이트**를 JSON 으로 읽기 때문이다
 * (FR-CFG-10, `internal/shared/settingsschema`). 상수를 참조하고 싶어도
 * 값을 적어라 — 그 상수와 어긋나면 `TC-CFG-2` 가 잡는다.
 *
 * 생성기를 두지 않은 이유는 D-CFG-2 다. 생성기는 원천을 Go 로 옮기고 이 파일을
 * 산출물로 만든다 — 그러면 게이트 밖에서 여기를 고친 사람이 조용히 되돌려진다.
 *
 * 값을 **읽고 얹는 방법**은 여기 없다. 전역 변수를 직접 만지므로 JSON 에 담을 수
 * 없고, `app-settings.js` 의 `SETTINGS_ACCESS` 가 그것을 진다 (FR-CFG-5).
 * 두 표의 키 집합이 같은지는 검사가 강제한다.
 *
 * 로드 순서: constants*.js 뒤, app-settings.js 앞.
 */
const SETTINGS_SCHEMA = [
  {"key":"themeName","type":"string","def":"dark","where":"Theme"},
  {"key":"customTheme","type":"object","def":null,"where":"Theme ▸ 사용자 정의"},
  {"key":"shortcuts","type":"object","def":{},"where":"Shortcuts"},
  {"key":"statusBar","type":"object","def":{},"where":"Status Bar"},
  {"key":"agentsPollInterval","type":"int","def":5000,"min":2000,"max":30000,"where":"Polling ▸ 에이전트 활동"},
  {"key":"statsInterval","type":"int","def":3000,"min":1000,"max":30000,"where":"Polling ▸ 시스템 통계"},
  {"key":"gitStatusInterval","type":"int","def":30000,"min":10000,"max":30000,"off":true,"where":"Polling ▸ git 상태 안전망"},
  {"key":"gitReposInterval","type":"int","def":3000,"min":1000,"max":30000,"where":"Polling ▸ 저장소 목록·탐색기"},
  {"key":"gitConsoleInterval","type":"int","def":2000,"min":1000,"max":10000,"where":"Polling ▸ git 콘솔"},
  {"key":"layoutPresets","type":"array","def":[],"where":"Presets"},
  {"key":"defaultPreset","type":"int","def":-1,"min":-1,"max":999,"where":"Presets ▸ 기본"},
  {"key":"fgTabNames","type":"bool","def":true,"where":"Display ▸ 전경 프로세스 이름"},
  {"key":"blockBrowserKeys","type":"bool","def":true,"where":"Shortcuts ▸ 브라우저 기본키 차단"},
  {"key":"pageTitle","type":"string","def":"","where":"Display ▸ 페이지 제목"},
  {"key":"confirmLeave","type":"bool","def":false,"where":"Display ▸ 떠날 때 확인"},
  {"key":"editorWordWrap","type":"bool","def":false,"where":"Display ▸ 편집기 줄바꿈"},
  {"key":"tabFixedWidth","type":"bool","def":false,"where":"Display ▸ 탭 너비 고정"},
  {"key":"tabWidthPx","type":"int","def":160,"min":40,"max":480,"where":"Display ▸ 탭 너비"},
  {"key":"focusEdgeLevel","type":"int","def":5,"min":0,"max":10,"where":"Display ▸ 비활성 창 가장자리"},
  {"key":"attnEdgeLevel","type":"int","def":5,"min":0,"max":10,"where":"Display ▸ 알림 가장자리"}
];

const SETTINGS_BY_KEY=Object.fromEntries(SETTINGS_SCHEMA.map(s=>[s.key,s]));

/**
 * FR-CFG-3: 저장된 값 하나를 **쓸 수 있는 값**으로 만든다.
 *
 * 범위 밖·타입 밖은 전부 기본값으로 떨어진다. 손으로 고친 `settings.json` 하나가
 * 초당 폴링을 만들거나 화면을 통째로 반전시키지 않아야 한다 — `FR-UFE-12`·
 * `FR-AED-9`·`FR-PIS-8` 이 각자 적던 규약을 표로 올린 것이다.
 *
 * `undefined` 는 **기본값이 아니라 `undefined` 로 돌려준다.** "서버가 말하지
 * 않았다" 와 "기본값으로 정했다" 는 다르고, 얹는 쪽이 그 차이를 본다 (FR-PIS-8).
 */
function settingValue(raw,spec){
  if(spec===undefined) return raw;
  if(raw===undefined||raw===null) return raw===null&&spec.def===null?null:undefined;
  switch(spec.type){
    case 'bool': return !!raw;
    case 'int': {
      const n=Math.round(Number(raw));
      if(!Number.isFinite(n)) return spec.def;
      if(n===0&&spec.off) return 0;
      if(spec.min!==undefined&&n<spec.min) return spec.def;
      if(spec.max!==undefined&&n>spec.max) return spec.def;
      return n;
    }
    case 'string': return typeof raw==='string'?raw:spec.def;
    case 'array': return Array.isArray(raw)?raw:spec.def;
    case 'object': return (raw&&typeof raw==='object'&&!Array.isArray(raw))?raw:spec.def;
    default: return raw;
  }
}
