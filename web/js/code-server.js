/**
 * Remote Terminal — code-server instance tracking
 */

// code-server 창 자체의 close 가 권위. 터미널 탭이 새로고침되어도 다른 창의
// 인스턴스는 살아있어야 한다(FR-B1: beforeunload 일괄 stop 제거).
const codeServerWatchers=new Map(); // id -> {win, hbTimer, pollTimer}
const codeServerPending=new Map();  // url -> id (팝업차단 폴백)
function codeServerHb(id){
  fetch('/api/code-server/heartbeat?id='+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
}
function codeServerTrack(id,win){
  // FR-E1: 동일 id 재호출 시 살아있는 이전 win 을 닫지 않는다.
  const prev=codeServerWatchers.get(id);
  if(prev){
    if(prev.win===win) return;                       // 같은 창 → 멱등
    if(prev.win && !prev.win.closed){
      // 기존 창이 살아있으면 새로 띄운 중복 창을 닫고 추적은 그대로 유지.
      try{win&&!win.closed&&win.close()}catch{}
      return;
    }
    // 기존 창이 이미 닫힌 상태에서만 교체.
    clearInterval(prev.hbTimer);clearInterval(prev.pollTimer);
    codeServerWatchers.delete(id);
  }
  codeServerHb(id);
  const hbTimer=setInterval(()=>codeServerHb(id),10000);
  const pollTimer=setInterval(()=>{
    if(!win||win.closed){
      clearInterval(hbTimer);clearInterval(pollTimer);
      codeServerWatchers.delete(id);
      fetch('/api/code-server/stop?id='+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
    }
  },1000);
  codeServerWatchers.set(id,{win,hbTimer,pollTimer});
}
// FR-D1: 백그라운드 탭에서 setInterval 이 throttle 되어 90s watchdog 안에
// 하트비트가 도달 못하는 경우를 막기 위해, 가시 상태로 전환되는 순간 즉시
// 모든 활성 인스턴스에 hb 1회 송신.
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible') return;
  for(const [id] of codeServerWatchers) codeServerHb(id);
});
