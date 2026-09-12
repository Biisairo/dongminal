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
 *   opts.timeout {number}    — ms. **기본이 있다** (아래). `0` 은 시한 없음.
 *   opts.signal {AbortSignal} — 있으면 `timeout` 보다 우선한다. 낡은 요청을
 *                        끊는 자리가 쓴다 (FR-GRF-31).
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
/**
 * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-6·7 (`GP-5`): **git 조회에는 기본 시한이 있다.**
 *
 *   이전 동작: `gitFetch`/`gitPost` 에 `AbortSignal` 이 없었다. `FR-RMS-29` 가
 *             "single-flight 인데 답이 오지 않으면 잠금이 영구히 남는다" 를
 *             **status 경로에서만** 고쳤고, `/api/git/log`·`refs`·`stash`·
 *             `records`·`worktrees`·`remotes`·`diff` 는 그대로였다
 *   새  동작: 같은 상수를 기본으로 쓴다. 호출자가 주면 그것이 이긴다
 *   이유:     History 는 그중 유일하게 잠금(`_loading`)을 갖는다 — 응답도
 *             거부도 오지 않는 연결(터널 끊김·프록시 중단)에서 `finally` 가
 *             실행되지 않아 커밋 목록이 **영구히** 멎었다 (`11 GP-5`).
 *             `history.js:970` 의 주석이 지키려던 것은 "거부" 였고 "무응답" 이
 *             아니다
 *
 * `0` 을 명시하면 시한이 없다 — 장시간 작업(jobs) 경로가 그것을 쓴다.
 */
function gitTimeout(o,def){
  return (o&&o.timeout!==undefined)?o.timeout:def;
}

async function gitFetch(path,params,opts){
  const o=opts||{};
  // 전송은 `core/api.js` 가 한다 (CLIENT_API_SRS FR-CAPI-14). 이 함수가 가진
  // 것은 git 화면의 계약뿐이다 — echo 와 stale. 종전에는 여기에도 `fetch`·
  // `r.json()`·`try/catch` 가 한 벌 더 있었고, 두 벌이면 M4 의 401 도 두 자리가 된다.
  //
  // **실패해도 본문을 읽는다.** 서버가 사유를 `{error, message}` 로 주고
  // (`apierr` 규약) 화면이 그 message 를 그대로 보인다 — 버리면 사용자는
  // "실패했다" 만 받고 무엇을 고칠지 알 수 없다. 그 성질은 아래 겹이 지킨다.
  const res=await apiGet(path,{query:params||undefined,
    timeout:gitTimeout(o,GIT_STATUS_FETCH_TIMEOUT_MS),signal:o.signal});
  // FR-GRF-8: 시한으로 끊긴 요청은 **망 실패와 같은 길**을 간다 — `core/api.js`
  // 가 그것을 `status:0` 으로 준다. 호출자는 이전 화면을 지키고 사유를 보인다.
  //
  // FR-GRF-31: **우리가 끊은 것은 실패가 아니다.** 새 요청이 이미 나갔으므로
  // 낡은 것으로 버린다 — 실패로 읽으면 화면이 없는 사유를 보인다.
  if(res.status===0)
    return {ok:false,data:null,stale:!!(o.signal&&o.signal.aborted),status:0};
  // 응답이 돌아온 뒤에 묻는다 — 그 사이에 리포가 바뀌었으면 이 응답은 남의 것이다.
  if(o.stale&&o.stale()) return {ok:false,data:null,stale:true,status:res.status};

  const ok=res.ok&&res.data!==null&&(!o.echo||gitEchoOk(res.data,o.echo));
  return {ok,data:res.data,stale:false,status:res.status};
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
 *
 * FR-GRF-6: 시한은 `gitFetch` 와 같은 기본을 쓴다. **잡을 여는 쓰기는
 * `opts.timeout:0` 을 준다** — 그 응답은 잡 id 만 싣고 곧바로 오지만, 서버가
 * 늦는 동안 끊으면 화면은 시작하지 않은 것으로 읽고 잡은 돈다.
 */
async function gitPost(path,body,opts){
  const o=opts||{};
  const res=await apiPost(path,body||{},
    {timeout:gitTimeout(o,GIT_WRITE_FETCH_TIMEOUT_MS),signal:o.signal});
  // `data!==null` 이다 — `!!data` 로 쓰면 `0`·`""`·`false` 도 실패가 된다. 그것들은
  // 유효한 JSON 본문이며, gitFetch 와 판정이 갈리면 두 규약이 된다.
  //
  // **코어의 `ok` 는 HTTP 성공만 본다** (FR-CAPI-15). 여기서 `data` 를 더 요구하는
  // 것은 git 종단이 언제나 JSON 을 내기 때문이고, 코어에는 204 를 내는 종단이
  // 있기 때문이다. 그 차이는 의도된 것이다.
  return {ok:res.ok&&res.data!==null,data:res.data,stale:false,status:res.status};
}
