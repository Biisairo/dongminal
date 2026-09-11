/**
 * 잡히지 않은 오류의 기록 (OBSERVABILITY_SRS FR-OBS-18·19 · M5 `G2-6`).
 *
 * 착수 시 `window.onerror`·`unhandledrejection` 훅이 **grep 0건**이었다.
 * 프론트의 예외는 콘솔에만 남고, 사용자는 그것을 신고에 붙이지 않는다 —
 * 붙이려면 개발자 도구를 열어야 한다는 것을 알아야 하고, 그 사실을 아는 사람은
 * 이 신고를 하지 않는다.
 *
 * ── 서버로 보내지 않는다 (D-OBS-4) ────────────────────────────
 *
 * 종단을 새로 파면 **그 종단이 오류 폭주의 증폭기가 된다** — 렌더 루프 안에서
 * 던지는 예외 하나가 초당 수십 번의 POST 가 되고, 그때 서버는 이미 문제를 겪는
 * 브라우저에게 더 얻어맞는다. 대신 마지막 N건을 메모리에 쥐고, 진단 오버레이와
 * `doctor` 로 가져갈 손잡이가 그것을 읽는다.
 *
 * ── 관측이지 처리가 아니다 (FR-OBS-19) ────────────────────────
 *
 * 기존 오류 표시를 바꾸지 않는다. `preventDefault` 를 부르지 않으므로 콘솔의
 * 빨간 줄은 그대로 나오고, 이 모듈은 그 옆에서 조용히 센다.
 *
 * 로드 순서: 가장 앞이어야 한다 — 이 훅이 걸리기 전의 예외는 잡히지 않는다.
 */
const ERRLOG_MAX=50;

const ErrorLog=(()=>{
  const items=[];
  let total=0;

  function push(kind,message,extra){
    total++;
    items.push({
      t:new Date().toISOString(),
      kind,
      // 문구를 자른다. 스택이 통째로 실리면 항목 몇 개가 배열을 덮는다.
      message:String(message==null?'':message).slice(0,500),
      ...extra,
    });
    // 오래된 것부터 버린다. **최신이 남는다** — 연쇄 실패에서 원인은 앞에
    // 있지만, 사용자가 신고하는 시점에 손에 잡히는 것은 마지막 화면이다.
    while(items.length>ERRLOG_MAX) items.shift();
  }

  return {
    /** 지금까지 쥔 항목 (오래된 것부터). */
    items:()=>items.slice(),
    /** 버린 것까지 포함한 전체 수. 몇 개를 못 봤는지가 진단의 절반이다. */
    total:()=>total,
    clear(){items.length=0;total=0},
    push,
  };
})();

// **훅은 이 파일이 로드되는 순간 걸린다.** 조건을 달지 않는 이유는 `?diag=1` 이
// 없을 때 일어난 오류가 정확히 우리가 놓쳐 온 것들이기 때문이다 — 진단을 켜야만
// 잡히는 훅은 재현되는 문제만 잡는다.
window.addEventListener('error',(e)=>{
  ErrorLog.push('error',e.message,{
    src:e.filename?String(e.filename).split('/').pop():'',
    line:e.lineno||0,
    col:e.colno||0,
    // 스택은 앞부분만 — 신고에 붙는 값이고, 전문은 항목 하나가 나머지를 덮는다.
    stack:e.error&&e.error.stack?String(e.error.stack).slice(0,800):'',
  });
});

window.addEventListener('unhandledrejection',(e)=>{
  const r=e.reason;
  ErrorLog.push('unhandledrejection',
    r&&r.message?r.message:r,
    {stack:r&&r.stack?String(r.stack).slice(0,800):''});
});

// 지원 창구가 집어 갈 손잡이. `__dongminalDebug` 와 같은 규약이다 —
// 콘솔에 한 줄을 쳐서 받아 갈 수 있어야 신고에 실린다.
window.__dongminalErrors=ErrorLog;
