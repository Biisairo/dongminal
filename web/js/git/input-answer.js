/**
 * Dongminal — 대화상자 입력의 서버 답 (SERVER_DRIVEN_ACTIONS_SRS GV-d).
 *
 * 입력이 옳은지는 **서버가 답한다** (D-SDA-1). 대화상자는 입력이 바뀌면 멈춘 뒤
 * `GET /api/git/actions?action=<id>&<입력>` 으로 묻고, 그 답을 `actionState` 로 그린다.
 * 실행 요청도 서버가 같은 판정으로 거절한다 (D-SDA-6).
 *
 * - 첫 답 전에는 `loading` 사유로 실행을 막는다 (FR-SDA-6).
 * - 다시 묻는 동안에는 실행만 막고 앞선 사유를 그대로 둔다 — 글자를 칠 때마다 사유
 *   줄이 "확인하는 중" 으로 깜박이지 않게 한다 (GR-3d).
 * - 늦게 온 앞선 답은 세대로 버린다.
 */
class GitInputAnswer {
  /**
   * @param {{repo:string, id:string, params:(v:Object)=>Object, fail:(res:Object)=>string,
   *   onChange?:(s:{kind:string,why:string}, d:Object)=>void}} o
   *   params 는 판정에 쓰이는 입력만 고른다. onChange 가 없으면 답을 대화상자의 setWhy 로 그린다.
   */
  constructor(o){
    this.repo=o.repo;
    this.id=o.id;
    this.params=o.params;
    this.fail=o.fail;
    this.onChange=o.onChange||null;
    this._key=null;
    this._seq=0;
    this._t=null;
    this._asking=false;
    this._state=this._of(actionState(null,false));
  }

  /** 대화상자의 validate 가 부른다. 판정에 쓰이는 입력이 바뀌었으면 묻는다. */
  why(v,d){
    const p=this.params(v);
    const key=JSON.stringify(p);
    if(key!==this._key){
      this._key=key;
      const seq=++this._seq;
      this._asking=true;
      TIMERS.cancel(this._t);
      this._t=TIMERS.after(GIT_BR_VALIDATE_DEBOUNCE_MS,()=>{this._t=null;this._ask(p,d,seq)},
        {owner:this,label:'git-input-answer'});
    }
    return this.state();
  }

  /** 지금 그릴 사유. 다시 묻는 중이면 실행만 막는다. */
  state(){
    if(this._asking&&this._seq>1) return {kind:GIT_DIALOG_WHY_PENDING,why:this._state.why};
    return this._state;
  }

  async _ask(p,d,seq){
    const id=this.id;
    const res=await gitFetch(GIT_API.actions,Object.assign({repo:this.repo,action:id},p),
      {stale:()=>seq!==this._seq||!d.alive(),echo:{repo:this.repo,action:id}});
    if(res.stale) return;
    this._asking=false;
    this._state=res.ok?this._of(actionState(res.data.actions[id],false))
      :{kind:GIT_DIALOG_WHY,why:this.fail(res)};
    if(this.onChange) this.onChange(this._state,d);
    else d.setWhy(this._state.kind,this._state.why);
  }

  _of(s){return s.enabled?{kind:'',why:''}:{kind:GIT_DIALOG_WHY,why:s.why}}
}
