/**
 * 브라우저 저장소의 **단일 경로** (OPTIMIZE_REFACTOR_SRS FR-OPT-11-3 · FEC-19 · FEU-18).
 *
 * 종전에는 `localStorage`·`sessionStorage` 호출이 파일마다 `try{…}catch{}` 로 감싸여
 * 흩어져 있었다 — 빈 catch 가 core 에만 75개였고, 실패는 `ErrorLog` 에도 남지
 * 않았다. 키도 상수와 리터럴이 섞였다.
 *
 * 이제 두 영역이 같은 동사를 갖는다.
 *
 *   PrefStore.local    기기의 것 (브라우저를 닫아도 남는다)
 *   PrefStore.session  이 탭의 것 (새로고침은 건너고, 탭끼리는 갈린다)
 *
 *   get(k)→문자열|null · set(k,v)→성공 · remove(k)→성공
 *   bool(k,def) · setBool(k,v)     '1'/'0' 으로 적는다. 모르는 값은 기본값 쪽이다
 *   json(k,def) · setJson(k,v)     깨진 JSON 은 def 다
 *
 * 저장소가 막힌 환경(사생활 모드·쿼터·SecurityError)은 **오류가 아니다** — 읽기는
 * 없는 값, 쓰기는 거짓이다. 다만 `ErrorLog.push('storage',…)` 로 흔적을 남긴다.
 *
 * `scripts/check-storage.mjs` 가 이 파일 밖의 직접 호출을 막는다.
 *
 * 로드 순서: error-log.js 바로 뒤 — 로드 시점에 저장소를 읽는 파일보다 앞이다.
 */

/**
 * 뜻이 이름에 있는 키. 종전에 리터럴로 흩어져 있던 것들이다 — 주제 상수가 이미 있는
 * 키(`SLOT_KEY`·`THEME_VARS_KEY`·`GIT_*_KEY` …)는 그 자리에 남는다.
 */
const STORE_KEYS=Object.freeze({
  // session — 이 탭의 시선
  activeWindow:'activeWindow',
  focusedPanes:'focusedPanes',
  displayMode:'displayMode',
  mobileBreakpoint:'mobileBreakpoint',
  // local — 기기의 취향
  attnSound:'attnSound',
  attnDesktop:'attnDesktop',
  agentsPanelOpen:'agentsPanelOpen',
  agentsWidth:'agentsWidth',
  agentsGroupFold:'agentsGroupFold',
  sandboxRecent:'dm.sbx.recent',
  // local — 이사가 끝나면 지우기만 하는 옛 키
  legacyAgentsPollMs:'agentsPollMs',
  legacyLspServerPaths:'lspServerPaths',
});

const PrefStore=(()=>{
  function fail(op,key,e){
    ErrorLog.push('storage',op+' '+key+': '+((e&&e.message)||e));
  }
  function area(name){
    const pick=()=>name==='session'?window.sessionStorage:window.localStorage;
    const get=(k)=>{
      try{ return pick().getItem(k) }
      catch(e){ fail('get',k,e); return null }
    };
    const set=(k,v)=>{
      try{ pick().setItem(k,String(v)); return true }
      catch(e){ fail('set',k,e); return false }
    };
    const remove=(k)=>{
      try{ pick().removeItem(k); return true }
      catch(e){ fail('remove',k,e); return false }
    };
    const json=(k,def)=>{
      const raw=get(k);
      if(raw===null) return def;
      try{ return JSON.parse(raw) }
      catch(e){ fail('parse',k,e); return def }
    };
    return {
      get, set, remove, json,
      // 기본값 쪽으로 기운다 — 기본이 참이면 '0' 만 거짓, 거짓이면 '1' 만 참이다.
      bool:(k,def)=>{ const v=get(k); return v===null?def:(def?v!=='0':v==='1') },
      setBool:(k,on)=>set(k,on?'1':'0'),
      setJson:(k,v)=>set(k,JSON.stringify(v)),
    };
  }
  return Object.freeze({local:area('local'),session:area('session')});
})();
