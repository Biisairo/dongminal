/**
 * Dongminal — 렌더러의 스크롤 갈무리·복원 (`Renderer.prototype` 증강)
 *
 * `renderer.js` 에서 **구간 이동**했다 (STRUCTURE_CLEANUP_SRS FR-STR-44).
 * 한 줄도 바뀌지 않았고, 바뀐 것은 클래스 본문이 객체 리터럴이 되며 멤버 끝의
 * `}` 가 `},` 가 된 것뿐이다 (`FE_MODULE_BOUNDARY_SRS` §7.3-②).
 *
 * 여기 모인 것은 하나의 물음이다 — **옮기기 전에 무엇을 적어 두고, 붙은 뒤에
 * 무엇을 되돌리는가** (UX_BATCH6_SRS FR-SCR-1 · PANE_DOM_RECONCILE_SRS FR-PDR-11·12).
 *
 * 로드 순서: `renderer.js` **뒤**여야 한다 — `Renderer` 가 이미 서 있어야 한다.
 */

Object.assign(Renderer.prototype, {

  /**
   * FR-PDR-11·12: 옮기기 **직전**의 시선. 절대 위치보다 먼저 "맨 아래에 붙어
   * 있었는가"를 적는다 — 출력이 흐르는 터미널에서는 그것만이 뜻을 잃지 않는다.
   */
  _grabScroll(p){
    const rec={p,atBottom:true,y:0,alt:false};
    try{
      const buf=p.term&&p.term.buffer.active;
      if(buf){
        rec.alt=buf.type==='alternate';
        rec.y=buf.viewportY;
        rec.atBottom=buf.viewportY>=buf.baseY;
      }
    }catch{}
    return rec;
  },

  /**
   * VIEW_SCROLL_RESTORE_SRS FR-VSR-24: DOM 의 `scrollTop` 을 **지금의 `ydisp`** 에
   * 맞춘다. 되돌리는 것이 아니라 **되읽히는 것**이다 (D-7).
   *
   * 요소가 문서에서 떨어지면 브라우저가 `.xterm-viewport.scrollTop` 을 버린다.
   * `ydisp` 는 인스턴스에 남으므로 캔버스는 여전히 그 줄을 그리고, **보이는 것과
   * 실제 스크롤이 갈린다** — 그것이 `U-3`·`U-17` 의 본체다 (SRS §2.8).
   *
   * xterm 이 스스로 고치지 못하는 이유는 `syncScrollArea` 가 캐시(`_lastScrollTop`)
   * 로 판정하기 때문이다. 그 캐시는 어긋나기 **전**의 값이라 "변한 것 없음"이 되고,
   * `_refresh` 는 영영 돌지 않는다.
   *
   * FR-VSR-25 / D-8: 새로 저장하는 값이 없고, xterm 내부 필드도 읽지 않는다.
   * `rowHeight` 는 공개 표면에서 나온다 — `(scrollHeight - clientHeight)` 가
   * `rowHeight × (length - rows)` 이므로 그 몫이다.
   *
   * 반환값은 **맞출 수 있었는가**다. 방금 붙은 요소는 크기가 아직 없는 프레임을
   * 지나며(`clientHeight` 가 0), 그때는 분모가 서지 않으므로 거짓을 돌려준다 —
   * 부르는 쪽이 그 한 프레임을 기다린다.
   */
  _syncViewportScroll(p){
    try{
      if(!p||!p.term||!p.el.classList.contains('vis')) return true;
      const buf=p.term.buffer.active;
      // 대체 화면에는 맞출 스크롤이 없다 (FR-PDR-12).
      if(buf.type==='alternate') return true;
      const vp=p.el.querySelector('.xterm-viewport');
      if(!vp) return true;
      const span=buf.length-p.term.rows;
      const room=vp.scrollHeight-vp.clientHeight;
      // 스크롤백이 없거나 크기가 아직 없다. 전자는 맞출 것이 없고 후자는 아직
      // 잴 수 없다 — 둘을 가르는 값이 없으므로 한 프레임 뒤에 다시 묻는다.
      if(span<=0||room<=0) return false;
      /**
       * FR-M9-29: **행 높이는 요소에서 낸다.** `room/span` 이 아니다.
       *
       *   이전 동작: `room * ydisp / span` — 즉 스크롤 영역이 `span` 줄에
       *             대응한다고 **가정**했다
       *   새  동작: 행 높이는 `clientHeight / rows` 이고, 그것으로 자리를 낸다
       *   이유:     영역이 낡아 있으면 그 가정이 거짓이고, 그러면 이 함수가
       *             **스스로 `ydisp` 를 망가뜨린다.** 사용자 로그가 그 자리다 —
       *             바닥(`ydisp=1508`)을 맞추려 `scrollTop` 을 최대(27721)로
       *             썼고, 낡은 영역에서 그 픽셀은 `1459` 줄이라 xterm 이
       *             `ydisp` 를 거기로 끌어내렸다
       *
       * 위의 흔들기가 영역을 되살리므로 여기 오면 대개 둘이 같다. 그래도 요소
       * 쪽을 쓰는 것은 **가정을 하나 줄이는 것**이고, 흔들기가 듣지 않는 판에서
       * 이 함수가 가해자가 되지 않게 한다.
       */
      const rh=vp.clientHeight/p.term.rows;
      if(!(rh>0)) return false;
      // 영역이 낡아 짧으면 그 안에서만 움직일 수 있다 — 넘겨 쓰면 브라우저가
      // 잘라내고, 잘린 값이 다시 `ydisp` 로 되읽힌다.
      const want=Math.min(Math.round(rh*buf.viewportY),room);
      // 반올림 한 칸의 차이로 대입하지 않는다. 대입은 scroll 이벤트를 내고,
      // 그 이벤트가 xterm 의 `_lastScrollTop` 을 실값으로 되돌려 자가회복까지
      // 정상화한다 — 없는 차이에 그 일을 시킬 이유는 없다.
      if(Math.abs(vp.scrollTop-want)>1) vp.scrollTop=want;
      return true;
    }catch{ return true }
  },

  /**
   * FR-PDR-10~12: 옮겨진 터미널 하나의 시선을 되돌린다.
   *
   * 맨 아래에 있었으면 **맨 아래로** 보낸다. 그 사이 출력이 들어와 버퍼가 길어졌어도
   * 옳은 자리이며, 라인 번호로 되돌리면 그 순간 `ydisp !== ybase` 가 되어 xterm 이
   * 이후 출력을 따라가지 않는다 (§2.3).
   *
   * 대체 화면에는 되돌릴 스크롤이 없다. 그 위에 픽셀을 대입하면 해가 된다.
   */
  _restoreScrollOf(rec){
    const p=rec&&rec.p;
    if(!p||!p.term||!p.el.classList.contains('vis')) return;
    try{
      const buf=p.term.buffer.active;
      if(rec.alt||buf.type==='alternate') return;
      if(rec.atBottom){
        /**
         * M9_SRS FR-M9-29 (M9-B2): **바닥 갈래도 흔든다.**
         *
         *   이전 동작: `scrollToBottom()` 하나. `ydisp === ybase` 면 그것은
         *             `scrollLines(0)` 이라 xterm 안에서 즉시 반환하고, 그래서
         *             `Viewport.syncScrollArea` 가 **돌 계기가 없다**
         *   새  동작: 한 줄 올렸다 내린다. 진짜 스크롤이므로 `onScroll` 이 나고
         *             xterm 이 스크롤 영역을 다시 잰다
         *   이유:     요소가 떨어져 있는 동안 버퍼가 자라면 `.xterm-scroll-area`
         *             의 높이가 **낡은 길이**로 남는다. 사용자 로그의 산수가
         *             그것을 확정했다 (2026-09-14): 영역 `28652px` = 낡은 길이
         *             `1508` × 행높이 `19.0` 인데 버퍼는 `1557` 줄이었고, 그래서
         *             스크롤바를 끝까지 내려도 `27721/19 = 1459` — **정확히 한
         *             화면(49줄) 위**에서 멎었다. 접수한 말이 그것이다
         *
         * 이것이 사용자가 찾아낸 회피법("살짝 올렸다 내리면 내려간다")과 같은
         * 동작이다 — 없던 것은 그 한 번이었다.
         *
         * 중간 스크롤 갈래에는 이 흔들기가 **이미 있었다** (아래 `scrollToLine`
         * 두 줄, FR-VSR-22). 바닥 갈래만 빠져 있었고, 그 갈래가 곧 "터미널을
         * 보던 대로 두고 나갔다 오는" 가장 흔한 경우다.
         */
        p.term.scrollToBottom();
        this._syncAfterRestore(p,true); return;
      }
      const max=Math.max(0,buf.length-p.term.rows);
      const target=Math.min(Math.max(0,rec.y),max);
      // xterm 은 `scrollToLine(ydisp)` 를 무시하므로(early return) 한 번 흔들어
      // `_onScroll` 을 깨운다 — 그래야 DOM 의 scrollTop 이 함께 맞는다.
      //
      // VIEW_SCROLL_RESTORE_SRS FR-VSR-22: 흔들기는 **갈무리한 자리의 이웃**에서
      // 출발한다.
      //
      //   이전 동작: `scrollToTop()` 으로 흔들었다. 두 번째 동작이 듣지 않으면
      //             화면이 **최상단에 남았다** — `U-3`("최상단으로 붙는다")과
      //             `U-17`("가끔")의 가설이 그것이고, V-VSR-11 이 그 기전을
      //             실물에서 재현했다 (방금 붙은 요소는 행 수·높이가 아직
      //             측정되지 않은 프레임을 지난다)
      //   새  동작: 이웃 줄로 흔든다. 같은 실패가 한 줄 차이로 끝난다
      //   이유:     복원은 최상단을 **결과로** 남기지 않는다 (FR-VSR-22).
      //             판정 규칙(FR-PDR-11 bottom-follow)은 건드리지 않는다 —
      //             재현 조건이 오기 전의 변경을 FR-VSR-23 이 금지한다
      if(target>0){ p.term.scrollToLine(target<max?target+1:target-1); p.term.scrollToLine(target) }
      else if(max>0){ p.term.scrollToBottom(); p.term.scrollToTop() }
      // FR-VSR-24: 갈래를 가리지 않는다. 여기는 흔들기가 `ydisp` 를 실제로 옮겨
      // xterm 이 따라오는 갈래지만, 가리면 가리지 않은 쪽이 다음 결함이 된다.
      //
      // 여기 있던 `if(vp&&rec.top) vp.scrollTop=rec.top` 은 제거했다 — `rec.top` 은
      // **이미 떼인 뒤**에 읽혀 언제나 0 이었고(SRS §2.8 ②), 그래서 한 번도 실행되지
      // 않는 줄이었다. 그 자리를 대신하는 것이 `_syncAfterRestore` 이며, 옛 픽셀이
      // 아니라 **지금의 `ydisp`** 에서 값을 낸다.
      this._syncAfterRestore(p);
    }catch{}
  },

  /**
   * FR-VSR-24: 맞춘다. 아직 크기가 없으면 **한 프레임만** 기다렸다 다시 맞춘다.
   *
   * 한 번이다 — 두 번째에도 크기가 없다면 그 위젯은 이번 그리기에서 보이지 않는
   * 것이고, 보이게 되는 순간은 그 자체가 새로운 이동이라 `FR-PDR-10` 의 장부를
   * 다시 지난다. 여기서 더 기다리면 사용자의 다음 조작과 경합한다 (NFR-VSR-2 가
   * rAF 를 금한 것과 같은 이유이며, 이 한 프레임은 그 조항이 이미 예외로 둔
   * 자리다 — `§7.1` 의 "방금 붙은 요소에는 크기가 없다").
   */
  _syncAfterRestore(p,nudge){
    const go=()=>{
      // FR-M9-29: **흔들기는 크기가 생긴 자리에서 한다.** 크기 없는 프레임에
      // 흔들면 xterm 이 영역을 0 으로 다시 재고, 그 0 이 그대로 남는다 (실측:
      // 이 검사가 5회 중 1회 흔들렸다).
      if(nudge) this._nudgeScrollArea(p);
      return this._syncViewportScroll(p);
    };
    if(go()) return;
    TIMERS.frame(go,{owner:this,label:'term-scroll-sync'});
  },

  /**
   * FR-M9-29: xterm 이 **스크롤 영역을 다시 재게** 한다.
   *
   * `ydisp === ybase` 면 `scrollToBottom()` 은 `scrollLines(0)` 이라 즉시
   * 반환하고, 그러면 `Viewport.syncScrollArea` 가 돌 계기가 없다. 한 줄
   * 올렸다 내리는 것이 그 계기다 — 사용자가 찾아낸 회피법과 같은 동작이다.
   *
   * 올릴 자리가 없으면(맨 위) 하지 않는다. 그때는 스크롤백이 없다는 뜻이고
   * 다시 잴 영역도 없다.
   */
  _nudgeScrollArea(p){
    try{
      const buf=p.term.buffer.active;
      if(buf.type==='alternate'||buf.viewportY<=0) return;
      p.term.scrollLines(-1);
      p.term.scrollToBottom();
    }catch{}
  },

  /**
   * UX_BATCH6_SRS FR-SCR-1: 다시 붙을 캐시 DOM 의 스크롤을 갈무리한다.
   *
   *   이전 동작: `_rSide` 가 `.ed-side-body` 를 매 render 마다 새로 만들고 캐시된
   *             `.git-view` 를 그리로 옮겼다. 문서에서 떼는 순간 그 하위의
   *             스크롤 위치는 브라우저가 버린다 — 변경 하나를 클릭할 때마다
   *             목록이 맨 위로 돌아간 자리가 그것이다 (SRS §2.6)
   *   새  동작: 옮기기 **전에** 재고, render 가 끝난 뒤 되돌린다
   *   이유:     터미널은 이미 같은 대비를 갖고 있다 (`_rLayout` 의
   *             `.xterm-viewport`). 없던 것이 git 뷰 쪽이다
   *
   * **어느 것이 스크롤러인지 묻지 않는다** — 하위 전부를 훑는다. 렌더러가
   * `.git-files` 같은 안쪽 이름을 알면 CSS 가 바뀔 때마다 여기가 낡는다.
   *
   * FR-SCR-4: 0 은 기록하지 않는다. 복원할 것이 없고, 새로 그려진 요소의 자연스러운
   * 자리를 0 으로 덮는 일도 없어야 한다.
   */
  _keepScrollAll(){
    const keep=this._scrollKeep=[];
    const push=n=>{
      const t=n.scrollTop,l=n.scrollLeft;
      if(t||l) keep.push([n,t,l]);
    };
    const take=el=>{
      // 이미 떼여 있으면 잴 것이 없다 — 떨어진 요소의 `scrollTop` 은 0 이다.
      if(!el||!el.isConnected) return;
      push(el);
      for(const n of el.querySelectorAll('*')) push(n);
    };
    const app=this.app;
    // git 뷰 — 사이드의 Changes 와 본문의 여섯 (FR-SCR-3).
    //
    // **탐색기는 여기 없다** — `FileTree.mount` 의 `_scrollY`(FR-EDT-68)가 자기
    // 대비를 갖는다. 같은 일을 두 벌로 하면 어느 쪽이 이겼는지 말할 수 없다.
    //
    // **터미널은 이제 여기 있다** (M9_SRS FR-M9-28 / M9-B2).
    //
    //   이전 동작: 터미널만 `_mountTabBody` 의 이동 갈래에서 갈무리했다 —
    //             즉 **요소가 떨어진 뒤**다. `_hideOthers` 가 `c.remove()` 로
    //             먼저 떼고, 그 뒤에 `_grabScroll` 이 `viewportY` 를 읽었다
    //             (실측: `grab … conn=false vis=false`)
    //   새  동작: 편집기와 **같은 시점**에, 문서에 붙어 보이는 동안 읽는다
    //   이유:     떼는 자리는 셋이고(`_hideOthers`·`_domGC`·`_place`) 그 셋보다
    //             앞선 유일한 공통 시점이 여기다 — FR-VSR-2 가 편집기에 대해
    //             세운 그 규약이며, **터미널만 그 밖에 있었다**
    //
    // 종전 주석은 "터미널은 이미 자기 대비를 갖고 있다" 였다. 대비는 있었으나
    // **자리가 틀렸다** — 그 문장이 이 결함을 여덟 달 가려 준 자리다.
    this._keepTermScroll();
    if(app.gitPanels) for(const p of app.gitPanels.values()) for(const el of p._els.values()) take(el);
    // VIEW_SCROLL_RESTORE_SRS FR-VSR-2 / D-2: **편집기 탭은 훑기로 잡히지 않는다** —
    // Monaco 의 스크롤은 DOM `scrollTop` 이 아니라 인스턴스가 든 값이다. 그래서
    // 자리를 묻지 않고 위젯에게 갈무리를 맡긴다.
    //
    // 여기여야 하는 이유는 **떼는 자리가 셋**이라는 것이다 — 탭 전환은
    // `_hideOthers`, 창·칸 전환은 `_domGC`, 배치 변경은 `_place`. 셋에 각각 훅을
    // 걸면 넷째 자리가 생길 때 조용히 빠진다. 이 시점은 그 셋보다 앞선다.
    if(app.fileEditors) for(const v of app.fileEditors.values()) if(v&&v.keepView) v.keepView();
  },

  /**
   * M9_SRS FR-M9-28 (M9-B2): **떼기 전의 터미널 자리.**
   *
   * 문서에 붙어 **보이는**(`isConnected` + `.vis`) 터미널만 잰다 — 그 둘이
   * 아니면 `viewportY` 는 사용자가 본 자리가 아니다. 판정은 FR-VSR-2 의 것과
   * 같은 문장이다.
   *
   * 보이지 않는 터미널을 적지 않는 것이 요점이다. 슬롯 둘이 같은 도구를 그릴 때
   * 한쪽만 보일 수 있고, 그때 안 보이는 쪽의 값으로 덮으면 보이는 쪽이 튄다.
   */
  _keepTermScroll(){
    const m=this._termKeep=new Map();
    const app=this.app;
    if(!app.tools) return;
    for(const [id,p] of app.tools){
      if(!p||!p.el||!p.el.isConnected||!p.el.classList.contains('vis')) continue;
      m.set(id,this._grabScroll(p));
    }
  },

  /**
   * 그 도구의 **떼기 전** 기록. 없으면 지금 읽는다 — 렌더 머리에 보이지 않았던
   * 터미널이 이번 그리기에서 처음 서는 경우이며, 그때는 되돌릴 앞자리가 없다.
   */
  _termScrollOf(p){
    const rec=this._termKeep&&this._termKeep.get(p.id);
    // `rec.p` 는 그 순간의 인스턴스다. 같은 id 로 다시 만들어졌으면 남의 자리다.
    if(rec&&rec.p===p) return rec;
    return this._grabScroll(p);
  },

  _restoreScroll(){
    const list=this._scrollKeep; this._scrollKeep=null;
    if(!list) return;
    for(const [n,t,l] of list){
      // 이번 render 에서 결국 붙지 않은 요소는 되돌릴 자리가 없다.
      if(!n.isConnected) continue;
      if(t) n.scrollTop=t;
      if(l) n.scrollLeft=l;
    }
  },
});
