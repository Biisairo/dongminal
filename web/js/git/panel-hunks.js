/**
 * GitPanel — 부분 스테이징의 조각 관측과 hover 툴바 (FR-GIT-278·279 · DIFF_HUNK_BAR_SRS).
 * `panel-diff.js` 의 증강 분할이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-4 · FEU-22). 조각은 서버가
 * 만든 diff 에서 오고, 화면에 그리는 것은 Monaco 하나다 — 여기는 그 위에 뜨는 툴바뿐이다.
 */
Object.assign(GitPanel.prototype, {
  // ── 부분 스테이징 (FR-GIT-278·279 · DIFF_HUNK_BAR_SRS) ──
  //
  // 패치는 **서버가 만든다** (D6). 여기서 만드는 것은 좌표뿐이다 —
  // (경로, 축, hunk 번호, 줄 범위, 관측 식별자). 패치 문자열을 조립하는 코드가
  // 이 파일에 없어야 하고, 있으면 그것이 임의 쓰기 표면이 된다.
  //
  // 좌표 **사상**도 이 파일의 것이 아니다 — `core/hunk-coords.js` 가 서버 규약을
  // 딛고 그것을 편집기 쪽과 나눠 쓴다 (D-2).

  /**
   * 조각 관측을 관리하고 머리의 한 줄을 갱신한다 (FR-DHB-4·5·50).
   *
   * **화면에 조각을 그리지 않는다.** 그리는 것은 Monaco 이고, 동작은 커서에
   * 따라 뜨는 툴바가 갖는다 — 이 함수가 만지는 DOM 은 안내 한 줄뿐이다.
   */
  _paintHunks(el,f){
    const note=el.querySelector('.git-diff-hunk-note');
    const on=!!(f&&f.repo&&GIT_HUNK_AXES.has(f.axis));
    if(!on){
      // FR-DHB-19: 부분 스테이징이 없는 자리다 (blame 모드·커밋 축·untracked).
      this._hunkKey=null; this._hunks=null;
      this._hunkBarHide();
      this._hunkNote(note,'');
      return;
    }
    // 대상이 그대로면 다시 부르지 않는다 — 폴링마다 재요청하면 관측이 매초
    // 바뀌고 그때마다 툴바의 좌표가 흔들린다 (_showTarget 과 같은 규약).
    const key=[f.repo,f.axis,f.path].join(RPT_SEP);
    if(this._hunkKey!==key){
      this._hunkKey=key; this._hunks=null;
      // 대상이 바뀌면 툴바가 가리키던 조각은 없는 것이다.
      this._hunkBarHide();
      // 다른 대상으로 옮겨 갔을 때만 사유를 지운다 — 같은 대상을 다시 받는 것은
      // 방금 그 거부가 일으킨 일이다.
      if(this._hunkErrKey!==key){this._hunkErr=null; this._hunkErrKey=null}
      this._loadHunks(f,key);
    }
    this._hunkNote(note,this._hunkText());
    // 관측이 커서 이동보다 늦게 도착하는 길이 있다 — 그때 커서 기준으로 다시
    // 판정하지 않으면 이미 조각 줄에 커서를 둔 사용자에게 툴바가 끝까지 뜨지
    // 않는다 (FR-DHB-52). 쓰기 중 버튼 비활성(FR-DHB-18)도 이 회차에 따라온다.
    this._hunkBarCursor();
  },

  async _loadHunks(f,key){
    const tok=this.token();
    // FR-GRF-6: 조회에는 시한이 있다 (gitFetch 의 기본).
    const r=await gitFetch(GIT_API.hunks,{repo:f.repo,axis:f.axis,path:f.path});
    const d=r.data;
    if(this.isStale(tok)||this._hunkKey!==key) return;
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔 수
    // 있다 (FR-GIT-54). 짝이 맞지 않는 응답이 화면에 닿아서는 안 된다.
    const q=(d&&d.requested)||{};
    if(!r.ok||!d||q.repo!==f.repo||q.axis!==f.axis||q.path!==f.path){
      this._hunks={err:GIT_HUNK_LOAD_FAIL}; this._paint(); return;
    }
    this._hunks={diffId:d.diffId||'',list:d.hunks||[],note:d.note||''};
    this._paint();
  },

  // FR-DHB-5: 머리의 한 줄이 말하는 넷. 아무 문제가 없으면 빈 문자열이고, 그때
  // 그 자리는 아무것도 차지하지 않는다.
  _hunkText(){
    const why=this._hunkBlocked();
    if(why) return why;
    if(this._hunkErr) return this._hunkErr;
    const h=this._hunks;
    if(!h) return GIT_HUNK_LOADING;
    if(h.err) return h.err;
    if(!h.list.length) return h.note||GIT_HUNK_NONE;
    return '';
  },

  /**
   * REPO_FIX 05 §3A-3: hunk 를 쓸 수 없는 사유. 문서가 dirty 면 화면의 diff(버퍼 기준)와
   * 서버 hunk(디스크 기준)가 다르다. utf-16 은 git 이 바이너리로 본다.
   */
  _hunkBlocked(){
    const v=this._diffView;
    if(!v||this.commitFile) return '';
    if(v.dirty) return GIT_HUNK_DIRTY;
    if(/^utf-16/.test(v.docEncoding())) return GIT_HUNK_UTF16;
    return '';
  },

  // FR-DHB-53: 내용이 같으면 다시 쓰지 않는다 — 폴링이 3초마다 같은 글자를 넣으면
  // 그 자리가 매초 깜빡인다 (옛 `box.dataset.sig` 와 같은 근거).
  _hunkNote(el,text){
    if(!el) return;
    const fail=!!text&&text===this._hunkErr;
    const sig=rptKey(text,fail?'1':'');
    if(el.dataset.sig===sig) return;
    el.dataset.sig=sig;
    // 서버가 보낸 사유가 이 자리에 닿는다 — 텍스트 노드로만 넣는다 (NFR-DHB-3).
    el.textContent=text;
    el.classList.toggle('vis',!!text);
    el.classList.toggle('fail',fail);
  },

  /**
   * FR-DHB-10~13: 모디파이드 에디터에 커서 툴바를 배선한다.
   *
   * `GitDiffView` 가 에디터를 세울 때·버릴 때 이 함수를 부른다 (D-4) — 그 클래스는
   * 관측을 모르고, 관측을 아는 쪽이 여기다. `ed` 가 `null` 이면 정리다.
   */
  _hunkBarWire(ed){
    this._hunkBarDispose();
    if(!ed) return;
    this._hunkBarEd=ed;
    // 새로 선 에디터는 포커스를 갖고 있지 않다. 클릭이 그것을 준다.
    this._hunkBarFocus=false;
    const node=this._hunkBarNode();
    // FR-DHB-12: 자리는 **커서 줄**이다. `getPosition` 이 null 이면 Monaco 가
    // 그리지 않으므로, 숨김이 곧 위치를 놓는 일이다 (위젯을 붙였다 뗐다 하지
    // 않는다 — FR-DHB-21).
    this._hunkBarWidget={
      getId:()=>GIT_HUNK_BAR_ID,
      getDomNode:()=>node,
      getPosition:()=>this._hunkBarPos||null,
      // 첫 줄의 조각에서 위쪽으로 뜰 자리가 없으면 에디터 경계를 넘어야 한다.
      allowEditorOverflow:true,
    };
    ed.addContentWidget(this._hunkBarWidget);
    this._hunkBarSubs=[
      // FR-DHB-11·12·37: **한 계기가 자리와 라벨을 함께 정한다.** 커서 이동은
      // 선택 변화로도 오므로 리스너를 둘로 두지 않는다.
      ed.onDidChangeCursorSelection(()=>this._hunkBarCursor()),
      // 커서가 이미 조각 줄에 있는 채로 포커스만 돌아오는 길이 있다 (다른 창을
      // 갔다 왔을 때·같은 줄을 다시 클릭했을 때). 그때 선택은 바뀌지 않으므로
      // 계기가 따로 필요하다.
      ed.onDidFocusEditorText(()=>{this._hunkBarFocus=true; this._hunkBarCursor()}),
      // FR-DHB-13 조건 2: 커서는 에디터를 떠나지 않는다 — `onMouseLeave` 를
      // 대신하는 조건이 포커스다.
      ed.onDidBlurEditorText(()=>{this._hunkBarFocus=false; this._hunkBarHide()}),
    ];
  },

  _hunkBarDispose(){
    for(const d of this._hunkBarSubs||[]) if(d&&d.dispose) d.dispose();
    this._hunkBarSubs=null;
    // FR-GIT-56 / FR-DHB-22: 에디터가 버려지기 **전에** 뗀다. 뒤에 떼려 하면 뗄
    // 대상이 이미 없다.
    if(this._hunkBarEd&&this._hunkBarWidget) this._hunkBarEd.removeContentWidget(this._hunkBarWidget);
    this._hunkBarEd=null; this._hunkBarWidget=null; this._hunkBarFocus=false;
    this._hunkBarPos=null; this._hunkBarHunk=-1;
  },

  // 툴바의 DOM 은 하나다 (FR-DHB-21) — 조각을 옮겨 다닐 때 자리와 라벨만 바뀐다.
  _hunkBarNode(){
    if(this._hunkBarEl) return this._hunkBarEl;
    const el=document.createElement('div');
    el.className='git-hunk-bar';
    /**
     * FR-DHB-13b: **포커스를 툴바로 넘기지 않는다.**
     *
     * 사라지는 조건 하나가 "에디터가 포커스를 잃으면" 이므로, 버튼이 포커스를
     * 가져가면 누르는 순간 툴바가 없어져 클릭이 닿지 않는다. hover 판이 같은
     * 함정에 빠졌고(FR-DHB-13a) 그때는 유예 타이머로 풀려다 실패했다 —
     * 사라지지 않아야 하는 조건은 "시간" 이 아니라 **"어디에 있는가"** 다.
     */
    el.addEventListener('mousedown',ev=>ev.preventDefault());
    el.addEventListener('click',ev=>{
      const b=ev.target.closest('.git-hunk-act');
      if(b&&!b.disabled) this._hunkAct(b.dataset.act);
    });
    this._hunkBarEl=el;
    return el;
  },

  // 조각의 마지막 새 줄. 겹침 판정·자리 클램프·좌표가 같은 식을 써야 한다.
  _hunkEnd(hunk){
    return hunk.newStart+Math.max(hunk.newLines,1)-1;
  },

  /**
   * FR-DHB-11a: 판정에 쓰는 줄 — `{s,e,empty}`.
   *
   * **판정과 적용 범위가 같은 규칙을 써야 한다.** 어긋나면 조각의 마지막 줄까지
   * 드래그한 선택에서 툴바가 사라진다 — 그때 커서(선택의 끝)는 조각 밖의 줄에
   * 있고 적용 범위는 조각 안이다. 그래서 이 한 자리가 둘에 답한다.
   */
  _hunkBarSel(){
    const ed=this._hunkBarEd;
    if(!ed) return null;
    const sel=ed.getSelection();
    if(!sel||sel.isEmpty()){
      const pos=ed.getPosition();
      return pos?{s:pos.lineNumber,e:pos.lineNumber,empty:true}:null;
    }
    let e=sel.endLineNumber;
    // 줄 끝에서 시작해 다음 줄 1열에서 끝나는 선택은 그 다음 줄을 **포함하지
    // 않는다** — 드래그로 줄을 고르면 흔히 그런 범위가 된다.
    if(sel.endColumn===1&&e>sel.startLineNumber) e--;
    return {s:sel.startLineNumber,e,empty:false};
  },

  /**
   * FR-DHB-11a: 툴바가 속한 조각 — **선택이 지금 조각과 겹치면 그것을 지킨다.**
   *
   * hover 판에서 "툴바가 속한 hunk"(FR-DHB-32)를 정한 것은 마우스였다. 커서 판에서
   * 그것을 대신하는 것이 이 앵커다. 지키지 않으면 두 조각을 걸친 선택이 **끝
   * 조각으로 툴바를 옮겨**, 사용자가 고르기 시작한 조각이 아닌 곳에 적용된다
   * (실측: V-DHB-9 가 ALPHA 대신 CHARLIE 를 올렸다).
   */
  _hunkBarAnchor(list,sel){
    const cur=list.find(x=>x.index===this._hunkBarHunk);
    if(cur&&sel.s<=this._hunkEnd(cur)&&sel.e>=cur.newStart) return cur;
    return gitHunkAt(list,sel.s);
  },

  /**
   * FR-DHB-11·12·13·14·20: **커서가 어느 조각에 있는가.**
   *
   * 관측이 오기 전에는 뜨지 않는다 — 경계를 모르는 동안 뜨는 버튼은 무엇에
   * 걸리는지 말할 수 없다. 관측이 커서 이동보다 늦게 도착하는 길이 있으므로
   * `_paintHunks` 도 이 함수를 부른다 (FR-DHB-52).
   */
  _hunkBarCursor(){
    const ed=this._hunkBarEd,h=this._hunks;
    if(!ed) return;
    if(!h||h.err||!h.list||!h.list.length){this._hunkBarHide();return}
    /**
     * FR-DHB-13 조건 2 — **이벤트로 추적한 상태**를 본다.
     *
     * `hasTextFocus()` 순간 조회에 매달면 폴링 회차(3초)의 값에 따라 툴바가 되다
     * 말다 한다 — 실측으로 흔들림 넷이 그렇게 났다. 내려가는 계기는 `blur`
     * **이벤트** 하나여야 한다: 그것이 스펙이 적은 조건이기도 하다.
     */
    if(!this._hunkBarFocus){this._hunkBarHide();return}
    const sel=this._hunkBarSel();
    const hunk=sel?this._hunkBarAnchor(h.list,sel):null;
    // FR-DHB-13 조건 1 · FR-DHB-14.
    if(!hunk){this._hunkBarHide();return}
    this._hunkBarHunk=hunk.index;
    // FR-DHB-12: **매 회차 커서 줄로 갱신한다.** 같은 조각 안에서 커서를 옮기면
    // 툴바도 그 줄로 내려온다 — 조각 첫 줄 고정이 "이상한 위치" 의 정체였다.
    // 선택이 조각 밖에서 시작했으면 조각 안으로 당긴다 — 조각 밖에 뜬 툴바는
    // 무엇에 걸리는지 말하지 않는다.
    const line=Math.min(Math.max(sel.s,hunk.newStart),this._hunkEnd(hunk));
    this._hunkBarPos={
      position:{lineNumber:Math.max(1,line),column:1},
      preference:[
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ],
    };
    this._hunkBarPaint();
  },

  _hunkBarHide(){
    if(!this._hunkBarPos) return;
    this._hunkBarPos=null; this._hunkBarHunk=-1;
    if(this._hunkBarEd&&this._hunkBarWidget){
      this._hunkBarEd.layoutContentWidget(this._hunkBarWidget);
    }
  },

  /**
   * FR-DHB-15·16·18: 붙는 동작은 축이 정하고, 라벨은 선택이 정한다.
   *
   * 버튼을 매번 다시 만들지 않는다 — 축과 라벨과 쓰기 상태가 같으면 그림도 같다.
   */
  _hunkBarPaint(){
    const ed=this._hunkBarEd,el=this._hunkBarEl,w=this._hunkBarWidget;
    if(!ed||!el||!w) return;
    if(this._hunkBarPos){
      const f=this.commitFile?null:this._diffTarget();
      const acts=(f&&GIT_HUNK_ACTS[f.axis])||[];
      // 붙을 동작이 없으면 뜨지 않는다 — 빈 상자는 무엇을 할 수 있는지 말하지
      // 않으면서 diff 를 가린다 (FR-DHB-15).
      if(!acts.length){this._hunkBarHide();return}
      const co=this._hunkBarCoords();
      // 좌표가 조각 전체면(선택이 없거나 바뀐 줄에 걸리지 않았다) 라벨도 조각의
      // 것이다 (FR-DHB-31·34).
      const lines=!!(co&&co.from);
      const blocked=this._hunkBlocked();
      const sig=[acts.join(','),lines?'l':'h',this._writing?'w':'',blocked].join('|');
      if(el.dataset.sig!==sig){
        el.dataset.sig=sig;
        el.innerHTML='';
        for(const act of acts){
          el.appendChild(UIKit.button({label:lines?GIT_HUNK_LINE_LABEL[act]:GIT_HUNK_LABEL[act],
            title:blocked||GIT_HUNK_TITLE[act],size:'lg',cls:'git-hunk-act',dataset:{act},
            disabled:!!this._writing||!!blocked}));
        }
      }
    }
    ed.layoutContentWidget(w);
  },

  /**
   * FR-DHB-30~35·38: 지금 무엇에 걸리는 동작인가 — `{hunk,from,to}`.
   *
   * **누를 때 다시 읽는다** (D-5). 라벨을 그린 시점과 누르는 시점 사이에 선택이
   * 바뀔 수 있고, 그 사이의 값을 들고 있으면 화면이 말한 것과 보내는 것이 달라진다.
   */
  _hunkBarCoords(){
    const h=this._hunks;
    if(!h||!h.list) return null;
    const hunk=h.list.find(x=>x.index===this._hunkBarHunk);
    if(!hunk) return null;
    const whole={hunk:hunk.index,from:0,to:0};
    const sel=this._hunkBarSel();
    // 커서만 있으면 조각 전체다 (FR-DHB-31). 정규화는 `_hunkBarSel` 한 자리에
    // 있다 (FR-DHB-11a) — 판정과 여기가 어긋나면 안 된다.
    if(!sel||sel.empty) return whole;
    // FR-DHB-32: 선택이 여러 조각을 걸쳐도 적용되는 것은 이 조각 안의 범위뿐이다.
    // 서버 `patch` 가 hunk 번호를 하나만 받으므로 그것이 규약의 한계다 (D-3).
    const s=Math.max(sel.s,hunk.newStart);
    const e=Math.min(sel.e,this._hunkEnd(hunk));
    if(s>e) return whole;
    const r=gitHunkRangeForLines(hunk,s,e);
    return r?{hunk:hunk.index,from:r[0],to:r[1]}:whole;
  },

  /**
   * 조각 하나에 동작을 적용한다 (FR-GIT-278·279).
   *
   * `diffId` 는 화면이 본 관측의 식별자다. 서버가 다시 만든 diff 와 다르면 409 로
   * 거부되고, 그때 화면은 조각을 다시 받는다 — 낡은 번호로 다른 곳을 고치지 않는다.
   */
  async _hunkAct(op){
    const f=this.commitFile?null:this._diffTarget();
    const h=this._hunks;
    const co=this._hunkBarCoords();
    if(!f||!h||!co||this._hunkBlocked()) return;
    if(this._writing){this.busyNote();return}
    const hunk=(h.list||[]).find(x=>x.index===co.hunk);
    const body={repo:f.repo,axis:f.axis,path:f.path,op,
      hunk:co.hunk,from:co.from,to:co.to,diffId:h.diffId};
    if(op===GIT_PATCH_REVERT){this._hunkRevert(body,f,hunk,co);return}
    this._afterHunk(await this.post(GIT_API.patch,body));
  },

  /**
   * revert 는 **파괴적이다** (FR-GIT-279) — 워킹 트리의 그 줄을 버린다. discard 와
   * 같은 규약을 지난다: 판정은 서버의 목록이 하고(GitConfirm), 확인을 거치며,
   * 실행 요청에 confirm 을 함께 보낸다 — 서버도 그것을 요구한다.
   */
  async _hunkRevert(body,f,hunk,co){
    // FR-DHB-42: 무엇을 되돌리는지 밝힌다. 줄 범위를 골랐으면 그 범위이고,
    // 아니면 조각의 머리다.
    const label=co.from
      ?(GIT_HUNK_SEL_LABEL+co.from+GIT_HUNK_SEL_SEP+co.to)
      :((hunk&&hunk.header)||'');
    await GitDialog.confirm({
      action:GIT_ACT_DISCARD,
      title:GIT_HUNK_REVERT_TITLE,
      targets:[f.path+GIT_HUNK_TARGET_SEP+label],
      // O8 의 선례: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
      hint:{note:GIT_HUNK_REVERT_NOTE,command:'git stash push -- '+gitShQuote(f.path)},
      run:async()=>{
        const res=await this.post(GIT_API.patch,Object.assign({confirm:true},body));
        this._afterHunk(res);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.writeReason(res),stderrTail:(res.data&&res.data.message)||''};
      },
    });
  },

  /**
   * 조각 쓰기 한 번의 처리.
   *
   * 성공이든 실패든 **관측을 놓는다** — 조각을 적용하면 남은 덩어리의 번호가 밀리고,
   * 실패가 stale 이었다면 화면이 보던 것이 이미 낡은 것이다. 어느 쪽이든 다음
   * 그리기에서 다시 받는다.
   */
  _afterHunk(res){
    // **거부 사유는 누른 자리에 보인다** (FR-DHB-6). 그 자리가 이제 Diff 탭의
    // 머리다 — `applyWriteFail` 의 안내 줄은 Changes 사이드의 골격에만 있어
    // 조각을 누른 사람에게 닿지 않는다.
    this._hunkErr=res.ok?null:this.writeError(res);
    // 사유는 **그 대상의 것**이다. 아래에서 목록을 다시 받으려고 키를 비우므로,
    // 어느 대상의 사유인지 따로 들고 있어야 다시 받는 그 회차에 지워지지 않는다.
    this._hunkErrKey=res.ok?null:this._hunkKey;
    this._diffInvalidate();
    if(res.ok){this._note=null; this.adopt(res.data); return}
    this.applyWriteFail(res);
  },

  /**
   * REPO_FIX 05 §3A-6 (F-5.1): 본문이 실제로 바뀐 회차 — 조각 목록과 diffId 를 함께 버리고
   * **곧바로** 다시 받는다. 받는 동안 `_hunks` 가 비어 있으므로 툴바 동작은 서지 않는다.
   *
   *   이전 동작: 키만 지우고 목록은 다음 그리기까지 남아, 그 사이 툴바가 낡은 조각·
   *             diffId 로 요청했다(#44)
   *   새  동작: 목록을 버리고 즉시 다시 받는다
   */
  _diffChanged(){
    this._hunkKey=null; this._hunks=null;
    this._hunkBarHide();
    const el=this._els.get('diff');
    if(el&&el.dataset.built==='1') this._paintHunks(el,(this.commitFile||this._blameOn)?null:this._diffTarget());
  },
});
