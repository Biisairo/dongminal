/**
 * Dongminal — 서버가 포트를 옮길 때 열린 화면의 **이사** (HOT_REBIND_SRS FR-HRB-26).
 *
 * 화면 설정 일부는 `localStorage` 에 있고, 그것은 출처(포트 포함)마다 따로다. 그래서 옮기기
 * 전에 서버에 맡기고(`POST /api/server/carry`), 새 주소에서 받아 되넣는다.
 *
 * 이 파일은 `<head>` 의 맨 앞에서 읽는다. 되넣기는 테마·언어를 `localStorage` 에서 읽는 머리
 * 스크립트보다 먼저 끝나야 하므로 동기 요청을 쓴다 — 기동 때 한 번, `?carry=` 가 있을 때만이다.
 */

const SERVER_CARRY_PARAM='carry';

/**
 * 주소에 `?carry=<토큰>` 이 있으면 맡긴 것을 받아 storage 에 넣고 주소에서 지운다.
 * 받지 못해도 지운다 — 새로 고칠 때마다 다시 묻지 않게.
 * @returns {boolean} carry 가 있었는가
 */
function serverCarryRestore(loc,storage,getSync,hist){
  const u=new URL(loc.href);
  const tok=u.searchParams.get(SERVER_CARRY_PARAM);
  if(!tok) return false;
  const data=getSync('/api/server/carry/'+encodeURIComponent(tok));
  if(data&&typeof data==='object'){
    for(const k of Object.keys(data)) if(typeof data[k]==='string') storage.setItem(k,data[k]);
  }
  u.searchParams.delete(SERVER_CARRY_PARAM);
  hist.replaceState(hist.state,'',u.pathname+u.search+u.hash);
  return true;
}

/** 동기 GET 하나. 실패하면 null. */
function serverCarryGetSync(path){
  try{
    const x=new XMLHttpRequest();
    x.open('GET',path,false);
    x.send();
    return x.status===200?JSON.parse(x.responseText):null;
  }catch(e){ return null }
}

/**
 * localStorage 를 맡기고 같은 호스트 이름의 새 포트로 간다. 맡기지 못해도 간다 — 설정만
 * 옛 주소에 남는다 (SRS R-2).
 */
async function serverMove(loc,storage,post,port){
  const snap={};
  for(let i=0;i<storage.length;i++){ const k=storage.key(i); snap[k]=storage.getItem(k) }
  const r=await post('/api/server/carry',snap);
  const tok=r&&r.ok&&r.data&&r.data.token?r.data.token:'';
  loc.assign(loc.protocol+'//'+loc.hostname+':'+port+'/'+(tok?'?'+SERVER_CARRY_PARAM+'='+encodeURIComponent(tok):''));
}

/** 이 화면을 새 포트로 옮긴다. `apiPost` 는 부를 때 서 있다. */
function serverMoveNow(port){ return serverMove(location,localStorage,apiPost,port) }

if(typeof location!=='undefined'&&typeof XMLHttpRequest!=='undefined'){
  try{ serverCarryRestore(location,localStorage,serverCarryGetSync,history) }catch(e){ console.warn('[server-move]',e) }
}
