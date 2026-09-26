// @ts-check
/**
 * GitStatusHub — 같은 root 의 `/api/git/status` 를 한 벌로 나눠 쓴다
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-4-1 · FEU-5 · FEU-M1 · FEC-12).
 *
 *   이전 동작: gitSignal 한 번에 Git 패널 1 + 탐색기 1 + 열린 문서마다 1 이 같은
 *             저장소의 status 를 따로 받았다 (문서 10개면 12건)
 *   새  동작: 탐색기와 dirty-diff 는 이것을 지난다. root 별 single-flight 와 짧은
 *             TTL(`GIT_STATUS_HUB_TTL_MS`) 로 한 요청을 나눠 쓴다
 *   이유:     답은 누가 묻든 같다
 *
 * **Git 패널의 collect 는 이것을 지나지 않는다.** 그쪽은 쓰기 세대·재시도 규약을
 * 스스로 갖고(`panel-poll.js`) 그 요청이 곧 clientId 임대다. 결과만 `feed` 로 넘겨
 * 탐색기가 요청 없이 다시 칠하게 한다 (FEU-M1).
 *
 * `invalidate()` 는 "지금부터의 물음은 지금 이후의 답을 받아야 한다" 다 — 저장·
 * 커밋 같은 즉시 신호와 `git_changed` 가 부른다. 그 전에 떠난 요청과 그 전의 캐시는
 * 나눠 쓰지 않는다. 그 뒤의 물음끼리는 여전히 한 요청이다.
 *
 * 가진 관측이 있으면 그 mark 를 `ifMark` 로 싣는다 (FR-OPT-4-7). 서버가
 * `unchanged:true` 로 답하면 가진 본문으로 채워 돌려준다 — 소비자는 생략을 모른다.
 * 옛 서버는 인자를 무시하고 전량으로 답한다.
 */
class GitStatusHub {
  /** @param {{clientId:()=>string}} opts */
  constructor(opts){
    this._cid=opts.clientId;
    /** @type {Map<string,{flight:{gen:number,p:Promise<any>}|null,last:{gen:number,at:number,r:any}|null,body:any,bodyAt:number,seq:number,done:number}>} */
    this._m=new Map();
    this._gen=0;
  }

  _entry(root){
    let e=this._m.get(root);
    if(!e){e={flight:null,last:null,body:null,bodyAt:0,seq:0,done:0};this._m.set(root,e)}
    return e;
  }

  invalidate(){ this._gen++ }

  /**
   * 그 root 의 status. 응답 모양은 `apiGet` 의 것이다 (`{ok,status,data}`).
   * @param {string} root
   * @returns {Promise<any>}
   */
  ask(root){
    const e=this._entry(root);
    const gen=this._gen;
    if(e.flight&&e.flight.gen===gen) return e.flight.p;
    if(e.last&&e.last.gen===gen&&Date.now()-e.last.at<GIT_STATUS_HUB_TTL_MS) return Promise.resolve(e.last.r);
    const seq=++e.seq;
    const prev=e.body;
    /** @type {Record<string,string>} */
    const query={repo:root};
    const cid=this._cid();
    if(cid) query.clientId=cid;
    if(prev&&prev.mark) query.ifMark=prev.mark;
    const p=apiGet(GIT_STATUS_API,{query,timeout:GIT_STATUS_FETCH_TIMEOUT_MS}).then(r=>{
      const out=gitStatusMerge(r,prev);
      if(e.flight&&e.flight.p===p) e.flight=null;
      // 늦게 떠난 요청의 답이 먼저 와도, 먼저 떠난 요청의 답이 그것을 덮지 않는다.
      if(seq>e.done){e.done=seq;this._keep(e,gen,out)}
      return out;
    });
    e.flight={gen,p};
    return p;
  }

  /**
   * Git 패널이 자기 요청을 떠나보낼 때 번호를 받는다 — `ask` 의 요청과 같은 줄에 선다.
   * @param {string} root
   * @returns {number}
   */
  depart(root){ return ++this._entry(root).seq }

  /**
   * Git 패널이 스스로 받은 관측을 넘긴다. `seq` 는 그 요청이 떠날 때 받은 번호다
   * (`depart`) — 나중에 떠난 요청의 답이 이미 있으면 버린다.
   * @param {string} root @param {any} r @param {number} [seq]
   */
  feed(root,r,seq){
    const e=this._entry(root);
    const n=typeof seq==='number'?seq:++e.seq;
    if(n<=e.done) return;
    e.done=n;
    this._keep(e,this._gen,r);
  }

  /**
   * 그 root 의 마지막 **성공한** 관측과 그 시각. 나이를 따지지 않는다 — 요청 없이
   * 다시 칠하는 자리(스탬프 틱)가 쓴다.
   * @param {string} root
   * @returns {{data:any,at:number}|null}
   */
  peek(root){
    const e=this._m.get(root);
    return e&&e.body?{data:e.body,at:e.bodyAt}:null;
  }

  _keep(e,gen,r){
    e.last={gen,at:Date.now(),r};
    const d=r&&r.ok?r.data:null;
    if(!d) return;
    if(d.isRepo===false){e.body=null;return}
    if(d.status){e.body=d;e.bodyAt=Date.now()}
  }
}

/**
 * `unchanged:true` 답을 가진 본문으로 채운다. 서버는 **보낸 mark 와 같을 때만**
 * 생략하므로 보낼 때 잡아 둔 본문이 그 관측이다. 짝이 맞지 않는 생략은 답이 아니다 —
 * 전송 실패와 같은 길(`status:0`)로 보내 이전 화면을 지킨다.
 *
 * Git 패널의 collect 도 이것을 쓴다 (FR-OPT-4-7).
 */
function gitStatusMerge(r,prev){
  const d=r&&r.data;
  if(!r||!r.ok||!d||d.unchanged!==true) return r;
  if(!prev||prev.mark!==d.mark) return {...r,ok:false,status:0,data:null};
  const data={...prev,...d};
  delete data.unchanged;
  return {...r,data};
}
