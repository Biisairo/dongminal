/**
 * git API 조회 한 번 (DEEPENING_REFACTOR_SRS 묶음 C).
 *
 * 이전에는 호출자 22곳이 각자 이 네 줄을 다시 썼다:
 *
 *   try{r=await fetch('/api/git/stash?repo='+encodeURIComponent(repo))}catch{r=null}
 *   if(r&&r.ok){try{d=await r.json()}catch{d=null}}
 *   if(this.panel.isStale(tok)) return;
 *   if(!d||!d.requested||d.requested.repo!==repo){ …실패… }
 *
 * 넷째 줄이 **echo 검증**이다. 서버가 응답마다 `requested` 를 되싣는 이유는 하나다
 * — 늦게 온 남의 응답을 자기 것으로 읽지 않는 것(FR-GIT-16). 그런데 그 계약을
 * 호출자 22곳이 각자 지켜야 했고, 실제로 지켜지지 않는 자리가 있었다:
 *
 *   core/app-git.js    fetch 6 · isStale 0 · echo 0
 *   git/commit-ops.js  fetch 2 · isStale 0 · echo 0
 *   git/confirm.js     fetch 1 · isStale 0 · echo 0
 *   git/tag.js         fetch 1 · isStale 0 · echo 1
 *
 * 이것은 정리가 아니라 **버그 부류 하나의 제거**다.
 *
 * ── 반환값이 셋인 이유 ──
 *
 * 데이터 또는 null 로는 부족하다. 호출자가 세 결과에 **다르게** 반응한다:
 *
 *   성공  → 그린다
 *   stale → 조용히 나간다 (오류를 보이면 화면이 거짓말한다 — 그 응답은 남의 것이다)
 *   실패  → 사유를 보이고 이미 받은 목록은 지우지 않는다
 *
 * 셋을 null 하나로 접으면 stale 이 실패로 보이고, 리포를 빨리 바꿀 때마다 오류가
 * 번쩍인다.
 */

/**
 * gitEchoOk 는 응답이 **내가 보낸 요청의 것인지** 본다.
 *
 * `requested` 의 모양이 종단마다 둘이다 — 문자열 하나(worktrees·signature)이거나
 * 객체(stash·branches·remotes·commit). 서버 계약이 그렇게 자라 있으므로 여기서
 * 둘 다 받는다. **`d.repo` 로 비교하지 않는다**: 그것은 서버가 정규화한 루트라
 * 보낸 값과 다를 수 있고, 그것으로 짝을 맞추면 목록이 영원히 실패로 남는다
 * (git/worktrees.js 가 적어 둔 함정).
 */
function gitEchoOk(d,echo){
  if(!d) return false;
  const req=d.requested;
  if(req===undefined||req===null) return false;
  if(typeof req==='string') return req===echo.repo;
  for(const k in echo) if(req[k]!==echo[k]) return false;
  return true;
}

/**
 * gitFetch 는 조회 하나를 돌려준다.
 *
 * @param {string} path   `/api/git/...`
 * @param {object|null} params 쿼리. URLSearchParams 로 조립하므로 호출자가
 *                        encodeURIComponent 를 빼먹을 자리가 없다.
 * @param {object} [opts]
 *   opts.stale  () => boolean — 참이면 `{stale:true}`. 응답을 버린다.
 *   opts.echo   {…}          — `requested` 와 대조할 값들. 어긋나면 실패다.
 *
 * echo·stale 은 **옵트인**이다 (FR-DPN-33). 그 개념이 없는 전역 조회
 * (`/api/git/repos`·`/api/git/policy`)에 토큰을 요구하면 호출자가 의미 없는 값을
 * 지어내 넣는다.
 *
 * @returns {{ok:boolean, data:any, stale:boolean, status:number}}
 *   status 는 HTTP 상태이며 망 실패는 0 이다. 503 을 판정으로 굳히는 자리가
 *   있으므로(`_gitOff`) 실어 보낸다.
 *
 * **불변식: `ok` 가 참이면 `data` 는 null 이 아니다.** 호출자가
 * `if(!res.ok) return` 뒤에 `res.data.xxx` 를 그대로 쓸 수 있는 근거이며,
 * `gitPost` 도 같은 불변식을 지킨다.
 *
 * 반대는 성립하지 않는다 — `ok` 가 거짓이어도 `data` 가 있을 수 있다(4xx 의
 * `{error, message}`). 그래서 실패 경로에서 `data` 를 읽을 때는 `res.data&&`
 * 로 가드한다.
 */
async function gitFetch(path,params,opts){
  const o=opts||{};
  const url=params?path+'?'+new URLSearchParams(params).toString():path;

  let r=null;
  try{r=await fetch(url)}catch{return {ok:false,data:null,stale:false,status:0}}
  if(o.stale&&o.stale()) return {ok:false,data:null,stale:true,status:r.status};

  // **실패해도 본문을 읽는다.** 서버가 사유를 `{error, message}` 로 주고
  // (`apierr` 규약) 화면이 그 message 를 그대로 보인다 — 버리면 사용자는
  // "실패했다" 만 받고 무엇을 고칠지 알 수 없다.
  let d=null;
  try{d=await r.json()}catch{d=null}
  // 파싱 뒤에 한 번 더 묻는다 — await 둘 사이에 리포가 바뀔 수 있다.
  if(o.stale&&o.stale()) return {ok:false,data:null,stale:true,status:r.status};

  const ok=r.ok&&d!==null&&(!o.echo||gitEchoOk(d,o.echo));
  return {ok,data:d,stale:false,status:r.status};
}

/**
 * gitPost 는 변경 요청 하나다. `gitFetch` 와 **같은 반환 모양**을 쓴다 —
 * 호출자가 조회와 변경에서 다른 규약을 외우지 않아도 된다.
 *
 * 실패해도 본문을 실어 보낸다: 서버가 사유를 `{error, message}` 로 주고
 * (`apierr` 규약) 화면이 그 message 를 그대로 보여야 하기 때문이다.
 *
 * echo·stale 은 없다. 변경은 사용자의 한 번의 행위이며, 늦게 온 남의 응답을
 * 자기 것으로 읽는 문제가 조회와 다르게 생기지 않는다 — 그리고 필요해지면
 * 그때 옵션을 준다.
 */
async function gitPost(path,body){
  let r=null;
  try{
    r=await fetch(path,{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body||{})});
  }catch{return {ok:false,data:null,stale:false,status:0}}
  let d=null;
  try{d=await r.json()}catch{d=null}
  // `d!==null` 이다 — `!!d` 로 쓰면 `0`·`""`·`false` 도 실패가 된다. 그것들은
  // 유효한 JSON 본문이며, gitFetch 와 판정이 갈리면 두 규약이 된다.
  return {ok:r.ok&&d!==null,data:d,stale:false,status:r.status};
}
