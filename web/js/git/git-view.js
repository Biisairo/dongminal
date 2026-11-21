/**
 * GitView — Git 창 탭 뷰의 기반 (REFACTOR3_FE_GITVIEW_SRS FR-FEV-1~5). 탭 뷰는 모두 이것의 하위다.
 *
 * 수명은 하나다. 패널이 칸을 주면 `mount(el)` 이 그 칸을 루트로 받아 골격을 세우고(`_build`), `paint()` 가
 * `_syncRepo()` 로 저장소가 바뀌었는지 보고 바뀌었으면 비우고(`reset`) 다시 받으며(`_load`), 저장소가 없어지면
 * `unmount()` 가 칸을 놓는다. 칸의 주인은 패널이므로 `adopt` 한다 — `dispose` 가 칸을 떼지 않는다(D-FEV-6).
 *
 * `_repo` 의 `undefined` 는 "아직 받지 않음", `null` 은 "저장소 없음" 이다.
 *
 * 응답 짝은 표 한 벌로 본다(D-FEV-1). 패널 세대(저장소가 바뀌었는가)는 언제나 보고, 채널을 준 표만 같은 채널의
 * 뒤 표에 밀린다. 밀림(`superseded`)과 낡음(`stale`)을 따로 두는 이유는 FR-GRF-24 다 — 밀린 응답은 잠금을
 * 건드리지 않고, 낡은 응답은 잠금을 놓은 뒤 버린다(D-FEV-2).
 */
class GitView extends View {
  constructor(panel){
    super();
    this.panel=panel;
    this.app=panel.app;
    this._repo=undefined;
    this._tickets=new Map();   // 채널 → {gen, ctl}
  }

  // ── 수명 ──

  mount(el){
    if(!el) return;
    this.adopt(el);
    this._build(el);
    this._repo=undefined;
  }

  /** 골격을 세운다. 하위가 덮어쓴다. */
  _build(_root){}

  unmount(){
    this.el=null;
    this._repo=undefined;
  }

  // ── 저장소 교체 ──

  /** 저장소가 바뀌었으면 다시 받는다. 그 뒤에도 붙어 있는지를 돌려준다. */
  _syncRepo(){
    if(this.panel.repo!==this._repo) this._adopt();
    return !!this.el;
  }

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(this._repo) this._load();
  }

  reset(){}

  _load(){}

  reload(){ return this._load() }

  // ── 세대 가드 ──

  /** 응답 짝의 표. `ch` 를 주면 같은 채널의 앞선 표를 이긴다 — 세대를 올리고 앞선 조회를 끊는다. */
  ticket(ch){
    const tk={ch:ch||null,gen:0,tok:this.panel.token(),signal:undefined};
    if(!ch) return tk;
    const c=this._cut(ch);
    c.ctl=(typeof AbortController!=='undefined')?new AbortController():null;
    tk.gen=c.gen;
    tk.signal=c.ctl?c.ctl.signal:undefined;
    return tk;
  }

  /** 같은 채널에 더 새 표가 있는가. 채널 없는 표는 밀리지 않는다. */
  superseded(tk){
    if(!tk.ch) return false;
    const c=this._tickets.get(tk.ch);
    return !c||c.gen!==tk.gen;
  }

  /** 밀렸거나 저장소가 바뀌었다. */
  stale(tk){ return this.superseded(tk)||this.panel.isStale(tk.tok) }

  /** 그 채널의 진행 중 응답을 버린다. */
  dropTicket(ch){ this._cut(ch) }

  _cut(ch){
    const c=this._tickets.get(ch)||{gen:0,ctl:null};
    if(c.ctl) c.ctl.abort();
    c.ctl=null;
    c.gen++;
    this._tickets.set(ch,c);
    return c;
  }
}
