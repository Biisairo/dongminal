/**
 * Dongminal — 태그 동작 (GIT_ACTIONS_SRS §3.3 / FR-GIT-260~262)
 *
 * 목록은 **Branches 탭의 `/api/git/refs`** 다 (FR-GIT-147) — 태그는 거기 4번째
 * 그룹으로 이미 보인다. 이 파일은 그 위에 얹는 **쓰기** 셋뿐이다: 생성 · 삭제 ·
 * push.
 *
 * 쓰기 경로는 `GitBranches` 와 같이 **static** 이다. 태그 메뉴는 Branches 탭의
 * refs 목록에서도 History 탭의 커밋 배지에서도 열리므로, 어느 한 탭의 인스턴스에
 * 묶여 있으면 다른 쪽에서 쓸 수 없다.
 *
 * 조용히 넘기지 않는 것 셋:
 *
 * - **로컬 삭제와 원격 삭제는 다른 항목이다** (FR-GIT-261). 하나가 다른 하나를
 *   자동으로 하지 않는다 — 메뉴 항목도 라우트도 둘이다. 둘 다 파괴적이므로
 *   `GitMenu` 의 2단계 확인을 거치고, 확인 문구의 명령은 **지우기 전 oid** 를
 *   싣는다 (FR-GIT-92·250.2).
 * - **메시지는 annotated·signed 에서만 뜻이 있다** (FR-GIT-260). lightweight 는
 *   객체를 만들지 않으므로 담을 자리가 없다 — 그 사실을 다이얼로그가 실행 전에
 *   보인다.
 * - **push 는 job 경로를 탄다** (FR-GIT-262·101~104). 원격 작업은 분 단위이고
 *   취소할 수 있어야 하며 인증 안내가 필요하다 — 새 실행 경로를 만들지 않는다.
 */
class GitTag {
  // ── 생성 (FR-GIT-260) ──

  /**
   * 생성 다이얼로그를 연다. `ref` 를 주면 대상을 그 커밋으로 고정해 연다 —
   * 커밋 메뉴의 "여기에 태그 생성"(GIT_MENUS.commit)이 그 길이다.
   */
  static create(panel,o){
    if(!panel||!panel.repo) return;
    return new GitTagCreate(panel,o||{})._show();
  }

  // ── 삭제 (FR-GIT-261) ──

  /**
   * 로컬만 지운다. 2단계 확인과 recovery hint 는 `GitMenu` 가 이미 거쳤으므로
   * 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다 (FR-GIT-250.1).
   */
  static async deleteLocal(panel,name){
    if(!panel||!panel.repo||!name) return;
    const res=await panel.post('/api/git/tag/delete',
      {repo:panel.repo,name,confirm:true});
    if(res.ok){panel.afterRefWrite(res.data);return res}
    panel.applyWriteFail(res);
    return res;
  }

  /**
   * 원격만 지운다. `git push <remote> --delete <tag>` 이므로 원격 작업이고,
   * 그래서 push 와 **같은 job 경로**를 탄다 — 인증이 필요하면 그 안내도 거기서
   * 온다 (FR-GIT-104).
   *
   * 원격 이름을 보내지 않는다 — 서버가 정한다 (FR-GIT-100 과 같은 규약).
   */
  static deleteRemote(panel,name){
    if(!name) return;
    return GitTag._job(panel,GIT_TAG_KIND_DELETE_REMOTE,{name,confirm:true});
  }

  // ── push (FR-GIT-262) ──

  // 태그 하나. `all` 이면 이름 없이 `--tags` 다 — 둘을 함께 보내면 서버가 무엇을
  // 밀지 가릴 수 없어 거부한다.
  static push(panel,name,all){
    if(!all&&!name) return;
    return GitTag._job(panel,GIT_TAG_KIND_PUSH,
      all?{all:true}:{name});
  }

  // ── 거들기 ──

  /**
   * 원격 작업 하나를 띄운다. `GitRemote` 가 그 수명의 전문가다 — 진행 표시·취소·
   * 인증 안내·같은 리포의 다른 원격 버튼 잠금이 전부 거기 있다 (FR-GIT-101~104).
   * 여기서 다시 만들면 두 벌이 되어 한쪽이 뒤처진다.
   */
  static _job(panel,kind,body){
    if(!panel||!panel.repo) return;
    return panel._remote().run(kind,body||{});
  }

  /**
   * 확인 문구에 보일 **지우기 전 oid** (FR-GIT-250.2).
   *
   * 메뉴의 대상은 두 곳에서 온다: Branches 탭의 refs 행(`oid` 가 있다)과 History
   * 탭의 커밋 배지(없다). 없으면 이미 받아 둔 refs 목록에서 찾는다 — 새 조회를
   * 만들지 않는다 (FR-GIT-147).
   *
   * 그래도 모르면 **값을 지어내지 않는다.** 서버가 실행 전에 진짜 oid 로 hint 를
   * 남기므로 복구 수단 자체가 사라지는 것은 아니다.
   */
  static oidOf(panel,t){
    if(t&&t.oid) return t.oid;
    const short=(t&&t.short)||'';
    for(const v of [panel&&panel._branchesView,panel&&panel._historyView]){
      const list=(v&&v._refs)||[];
      const hit=list.find(r=>r.kind===GIT_REF_KIND_TAG&&r.short===short);
      if(hit&&hit.oid) return hit.oid;
    }
    return '';
  }

  // 확인 문구의 명령에 쓸 원격 이름. 요청에는 싣지 않는다 — 서버가 정한다.
  static remoteOf(panel){
    const up=((panel&&panel.statusOf&&panel.statusOf())||{}).upstream||'';
    const i=up.indexOf(GIT_BR_PREFIX_SEP);
    return i>0?up.slice(0,i):GIT_TAG_REMOTE_FALLBACK;
  }
}

/**
 * 태그 생성 다이얼로그 (FR-GIT-260, 검증 V187·V188).
 *
 * 골격은 `GitDialog` 다 (FR-GIT-171) — 이름 / 대상 / 종류 / 메시지 4필드를 그것에
 * 선언하고, 이 클래스는 이름 검사와 실행만 안다. 종류의 첫 선택지가 기본이고
 * 그것이 안전한 쪽이다 (FR-GIT-173): lightweight 는 객체도 서명 키도 필요 없다.
 *
 * 이름은 입력 중 `/api/git/tag/validate` 로 검사하고 **위반이면 실행을 막는다**
 * (FR-GIT-250.3) — 서버도 같은 것을 막지만, 실행해 보고 알려 주면 사용자는 왜
 * 막혔는지 모른다. `exists:true` 는 규칙 위반이 아니다: 사유가 달라야 사용자가
 * 무엇을 할지 안다.
 */
class GitTagCreate {
  constructor(panel,o){
    this.panel=panel;
    this.repo=panel.repo;
    this.ref0=o.ref||'';
    this.name0=o.name||'';
    this.why='';      // 사람이 읽는 사유
    this.whyKind='';  // '' | empty | pending | invalid | exists | message | fail
    this._seq=0;
    this._nameWhy=''; this._nameWhyKind='';
  }

  _show(){
    return GitDialog.open({
      id:'git-tag-create',ns:'gtc',action:'tag_create',
      title:GIT_TAG_CREATE_TITLE,runLabel:GIT_TAG_CREATE_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gtc-name',
         placeholder:GIT_TAG_NAME_PH,value:this.name0},
        // 커밋 메뉴에서 오면 그 커밋이 채워져 있다. 비우면 HEAD 다 (FR-GIT-260).
        {key:'ref',type:GIT_DIALOG_TEXT,cls:'gtc-ref',fieldCls:'gtc-refrow',
         placeholder:GIT_TAG_REF_PH,value:this.ref0},
        {key:'kind',type:GIT_DIALOG_RADIO,cls:'gtc-kind',fieldCls:'gtc-kindrow',
         label:GIT_TAG_KIND_LABEL,opts:GIT_TAG_KIND_OPTS},
        {key:'message',type:GIT_DIALOG_TEXT,cls:'gtc-msg',fieldCls:'gtc-msgrow',
         placeholder:GIT_TAG_MSG_PH},
      ],
      validate:(v,d,key)=>this._check(v,d,key),
      run:v=>this._run(v),
    });
  }

  /**
   * 실행을 막는 사유. 둘을 본다: 이름(왕복이 필요하다)과 메시지(즉시 안다).
   *
   * **이름 판정이 먼저다** — 그것이 없으면 만들 수 없고, 메시지는 종류에 따라
   * 뜻이 생겼다 사라진다.
   */
  _check(v,d,key){
    if(!key||key==='name') this._onName(v,d);
    return this._merge(v);
  }

  _onName(v,d){
    if(this._t) clearTimeout(this._t);
    const name=(v.name||'').trim();
    if(!name){this._setName('empty',GIT_TAG_WHY_EMPTY);return}
    this._t=setTimeout(()=>{this._t=null;this._validate(name,d)},GIT_BR_VALIDATE_DEBOUNCE_MS);
    // 검사 중에는 실행을 막는다 — 판정을 모르는 동안 실행을 열어 두면 규칙 위반이
    // 그대로 지나간다.
    this._setName(GIT_DIALOG_WHY_PENDING,'');
  }

  // 이름 사유가 있으면 그것이 이긴다. 없으면 메시지를 본다 — annotated·signed 는
  // 태그 객체를 만들고 객체에는 메시지가 있어야 한다 (FR-GIT-260).
  _merge(v){
    if(this._nameWhyKind) return this._set(this._nameWhyKind,this._nameWhy);
    const kind=v.kind===undefined?GIT_TAG_KIND_LIGHT:v.kind;
    if(kind!==GIT_TAG_KIND_LIGHT&&!(v.message||'').trim())
      return this._set('message',GIT_TAG_WHY_NEED_MSG);
    return this._set('','');
  }

  async _validate(name,d){
    if(!d.alive()) return;
    const seq=++this._seq;
    const q=new URLSearchParams({repo:this.repo,name});
    // 뒤늦게 온 이전 이름의 판정을 지금 이름의 것으로 읽지 않는다 — 그 가드가
    // 이제 echo 로 선다.
    const res=await gitFetch('/api/git/tag/validate',{repo:this.repo,name},
      {stale:()=>seq!==this._seq||!d.alive(),echo:{repo:this.repo,name}});
    if(res.stale) return;
    if(!res.ok){this._tell(d,'fail',GIT_TAG_VALIDATE_FAIL); return}
    const dt=res.data;
    if(!dt.ok){this._tell(d,'invalid',dt.reason||GIT_TAG_VALIDATE_FAIL);return}
    // 이미 있는 이름은 규칙 위반이 아니다 — 사유가 달라야 사용자가 무엇을 할지 안다.
    if(dt.exists){this._tell(d,'exists',GIT_TAG_WHY_EXISTS);return}
    this._tell(d,'','');
  }

  _set(kind,why){this.whyKind=kind;this.why=why;return {kind,why}}

  _setName(kind,why){this._nameWhyKind=kind;this._nameWhy=why}

  _tell(d,kind,why){
    this._setName(kind,why);
    const r=this._merge(d.values());
    d.setWhy(r.kind,r.why);
  }

  async _run(v){
    const kind=v.kind===undefined?GIT_TAG_KIND_LIGHT:v.kind;
    const res=await this.panel.post('/api/git/tag',{
      repo:this.repo,
      name:(v.name||'').trim(),
      ref:(v.ref||'').trim(),
      kind,
      // lightweight 에는 뜻이 없다 — 서버도 버리지만 보내지 않는 것이 정직하다.
      message:kind===GIT_TAG_KIND_LIGHT?'':(v.message||'').trim(),
    });
    if(res.ok){
      // 조작 후 목록·상태를 갱신한다 (FR-GIT-160) — 태그도 refs 의 한 그룹이다.
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175). signed 인데 서명 키가 없으면 git 의 사유가 그대로 여기 온다.
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (branches.js 와 같은 규약).
window.GitTag=GitTag;
window.GitTagCreate=GitTagCreate;
