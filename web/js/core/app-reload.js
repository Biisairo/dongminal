/**
 * Dongminal — 내부 새로고침 (SOFT_RELOAD_SRS)
 *
 * **페이지를 다시 열지 않고 서버의 사실을 다시 받아 화면을 맞춘다.**
 *
 * `location.reload` 는 가진 것을 전부 버리고 처음부터 세운다 — 편집기 탭의
 * 미저장 내용, 탐색기의 펼침·스크롤, Git 패널의 열린 탭이 함께 사라진다 (§2.3).
 * 사용자가 원한 것은 그것이 아니라 **다시 가져오는 것**이다.
 *
 * 여기 있는 것은 **부르는 순서뿐이다.** 복원 경로 다섯은 이미 SSE 의 `onopen` 이
 * 쓰고 있고(§2.1), 두 벌로 만들면 한쪽만 고쳐진다 (D-1).
 */
Object.assign(App.prototype, {
  /**
   * FR-SRL-1: 정해진 순서로 다시 가져온다. **워크스페이스가 가장 먼저다** —
   * 창·탭·도구의 구성이 나머지 전부의 전제이기 때문이다.
   *
   * FR-SRL-4: 한 갈래가 실패해도 나머지는 계속한다. 부분적으로라도 최신에
   * 가까워지는 것이, 가장 필요한 순간(부분 장애)에 아무것도 못 하는 것보다 낫다.
   */
  async softReload(){
    // FR-SRL-2: 겹쳐 돌면 낡은 응답이 새 것을 덮는다 (FR-GRR-4 와 같은 근거).
    if(this._softReloading) return false;
    this._softReloading=true;
    this._softReloadPaint(true);
    try{
      // ① 구독이 죽어 있으면 되살린다. 이것이 먼저인 이유는, 죽은 채로 두면
      //    지금 받아 온 것이 **다음 변화부터 다시 낡기** 때문이다 (§2.2).
      this._softStep('sse',()=>{
        const es=this._sse;
        if(!es||es.readyState===2){ if(this._sseKick) this._sseKick() }
      });
      // ② 워크스페이스. 인자 없이 부르면 rev 비교를 건너뛰고 무조건 받아 온다
      //    (`app-cmd.js` 의 `typeof rev==='number'`).
      await this._softStepAsync('workspace',()=>this._onWorkspaceChanged());
      // ③ 워크스페이스에 없는 것들. SSE 는 **변화**만 나르므로 합류 시점의
      //    사실은 이 복원으로만 온다.
      this._softStep('attn',()=>this._attnRestore&&this._attnRestore());
      this._softStep('activity',()=>this._activityRestore&&this._activityRestore());
      this._softStep('background',()=>this._bgRefresh&&this._bgRefresh());
      this._softStep('focus',()=>this._focusRestore&&this._focusRestore());
      this._softStep('foreground',()=>this._fgRestore&&this._fgRestore());
      // ④ 목록과 패널.
      await this._softStepAsync('editors',()=>this._edLoad&&this._edLoad());
      this._softStep('gitRepos',()=>this._gitReposRefresh&&this._gitReposRefresh());
      this._softStep('gitPanel',()=>{
        const p=this.gitPanel;
        if(p&&typeof p.refresh==='function') p.refresh();
      });
      // WORKBENCH_REVIEW_SRS FR-WBR-95: 살아 있는 트리 뷰는 `_edTrees` 에 있다.
      //
      //   이전 동작: `w.editor.refresh()` — `w.editor` 는 창 레코드의
      //             `{root, side, explorerWidth}` 라 `refresh` 가 없고,
      //             `typeof` 가드가 그것을 **조용히 삼켰다**
      //   새  동작: `_edTrees` 의 뷰마다 `refresh()` (FR-EDT-64 — 펼쳐진 겹만
      //             다시 읽고 펼침을 보존한다)
      //   이유:     내부 새로고침은 "서버 상태를 다시 받는" 기능인데 탐색기만
      //             낡은 채 남았다
      //
      // 같은 루트를 보는 칸이 여럿이어도 요청은 한 벌이다 — `_busy` 가 store 로
      // 위임하므로 둘째 호출이 그 자리에서 돌아간다 (FR-SVS-20).
      this._softStep('trees',()=>{
        for(const t of (this._edTrees?this._edTrees.values():[])){
          if(t&&typeof t.refresh==='function') t.refresh();
        }
      });
      // ⑤ 터미널 (FR-SRL-5, D-2): **전부** 다시 붙인다. 화면이 어긋난 것 같을 때
      //    부르는 기능이므로, 살아 보이는 연결도 믿지 않는다.
      this._softStep('terminals',()=>this._softReconnectTools());
      // ⑥ 다시 그린다.
      this._softStep('render',()=>this.render&&this.render());
    }finally{
      this._softReloading=false;
      this._softReloadPaint(false);
    }
    return true;
  },

  // FR-SRL-4: 한 갈래의 실패를 삼키되 삼킨 사실은 남긴다.
  _softStep(name,fn){
    try{ fn() }catch(err){ console.error('[reload] '+name,err) }
  },

  async _softStepAsync(name,fn){
    try{ await fn() }catch(err){ console.error('[reload] '+name,err) }
  },

  /**
   * FR-SRL-5·7: 모든 터미널을 다시 붙인다.
   *
   * `_exited` 인 것은 건드리지 않는다 — 그 판정은 서버의 통보로 섰고(FR-RCS-1),
   * 뒤집으면 폭주가 되살아난다 (D-4).
   */
  _softReconnectTools(){
    let n=0;
    for(const p of (this.tools?this.tools.values():[])){
      if(p&&typeof p.reconnectNow==='function'&&p.reconnectNow()) n++;
    }
    return n;
  },

  // FR-SRL-11: 도는 동안 그 사실을 보인다. 표시가 없으면 사용자는 눌린 줄 모르고
  // 다시 누른다.
  _softReloadPaint(busy){
    const b=document.getElementById(RELOAD_BTN_ID);
    if(!b) return;
    b.classList.toggle('busy',!!busy);
    b.disabled=!!busy;
    b.title=busy?RELOAD_BUSY_TITLE:RELOAD_TITLE;
  },

  /**
   * FR-SRL-8: 버튼을 배선한다.
   *
   * **단축키는 여기서 다루지 않는다.** 앱에는 이미 설정에서 바꿀 수 있는 단축키
   * 체계가 있고(`SHORTCUT_DEFAULTS` · `executeAction`), 그것이 터미널·브라우저
   * 보다 앞서는 우선순위까지 정한다 (shortcuts.md). 별도 리스너를 달면 그 체계를
   * 우회해 사용자가 키를 바꿀 수도, 충돌을 풀 수도 없게 된다 — `softReload` 는
   * 다른 동작들과 **같은 길**을 탄다 (FR-SRL-9).
   */
  _initSoftReload(){
    const b=document.getElementById(RELOAD_BTN_ID);
    if(!b) return;
    b.title=RELOAD_TITLE;
    b.addEventListener('click',()=>this.softReload());
  },
});
