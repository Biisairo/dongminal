/**
 * Dongminal — 개별 설정의 **초기화와 즉시 반영** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나하나가 화면에 붙는 자리다 — 탭 제목 · 탭 폭 · 전경 탭 이름 · 브라우저
 * 키 · 이탈 확인 · 포커스/주의 가장자리 · 줄바꿈. 저마다 `_init*` 하나로 리스너를
 * 걸고, 값이 바뀌면 그 자리에서 화면까지 따라간다.
 *
 * **모달과 갈린 이유**: 이 메서드들은 설정창이 없어도 돈다 (부팅이 부른다).
 * 모달은 그것들을 **보여주는** 표면일 뿐이다.
 */
Object.assign(App.prototype, {
  /**
   * PAGE_TITLE_SRS FR-PGT-8: `document.title` 을 쓰는 유일한 자리.
   *
   * 주의 배지(FR-PAN-13b)가 제목 전체를 다시 쓰므로, 설정값을 다른 곳에서
   * 넣으면 다음 `_attnRefresh` 에 지워진다. 합성은 여기 하나뿐이어야 한다.
   */
  _applyPageTitle(){
    const n=this._attn?this._attn.size:0;
    document.title=(n?'('+n+') ':'')+effectiveTitle();
  },

  // FR-PGT-1: Settings ▸ Display 의 `페이지 제목`.
  _initPageTitle(){
    const el=document.getElementById('ds-title');
    if(!el) return;
    el.value=pageTitle;
    el.addEventListener('input',()=>{
      pageTitle=el.value;
      // FR-PGT-9: 저장을 기다리지 않고 지금 값이 탭에서 어떻게 보이는지 보인다.
      this._applyPageTitle();
      // FR-PGT-5: 글자마다 PUT 을 보내지 않는다.
      TIMERS.cancel(this._titleSaveTimer);
      this._titleSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-title'});
    });
  },

  /**
   * TAB_WIDTH_SRS FR-TBW-1·2·10: Settings ▸ Display 의 `탭 너비 고정`과 그 폭.
   *
   * 값이 서버에 있는 이유는 다른 표시 설정과 같다 (FR-TBW-8) — 기기를 옮겨도
   * 따라와야 하고, 브라우저 탭별 저장으로는 그것이 서지 않는다.
   *
   * 폭 입력은 `input` 마다 적용하되 저장은 미룬다 — 타이핑 한 글자마다 PUT 을
   * 보내면 요청이 글자 수만큼 난다 (`ds-title` 과 같은 규약).
   */
  _initTabWidth(){
    const cb=document.getElementById('ds-tabfix');
    const num=document.getElementById('ds-tabw');
    if(!cb||!num) return;
    cb.checked=tabFixedWidth;
    num.value=String(tabWidthPx);
    applyTabWidth();
    cb.addEventListener('change',()=>{
      tabFixedWidth=cb.checked;
      applyTabWidth();
      this.saveSettings();
    });
    num.addEventListener('input',()=>{
      // FR-TBW-4: 자르는 것은 적용하는 값뿐이다 — 입력란의 글자를 그때그때
      // 고쳐 쓰면 타이핑이 튄다 (`160` 을 지우고 `9` 를 치는 순간 `40` 이 된다).
      tabWidthPx=clampTabWidth(num.value);
      applyTabWidth();
      TIMERS.cancel(this._tabwSaveTimer);
      this._tabwSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-tabw'});
    });
    /**
     * 포커스를 놓을 때 두 가지를 한다.
     *
     * ① 입력란을 실제로 쓰이는 값과 맞춘다 — 잘린 사실이 보여야 사용자가 왜 그
     *    폭인지 안다 (FR-TBW-4).
     * ② **곧바로 저장한다.** 디바운스는 타이핑 중 요청이 글자 수만큼 나는 것을
     *    막는 장치이지 확정을 미루는 장치가 아니다 — 값을 바꾸고 바로 새로고침하면
     *    500ms 가 지나지 않아 **입력이 통째로 날아갔다** (실측, W7). 포커스를
     *    놓는 순간이 곧 확정이므로 그때 미룰 이유가 없다.
     */
    num.addEventListener('blur',()=>{
      num.value=String(tabWidthPx);
      TIMERS.cancel(this._tabwSaveTimer);
      this.saveSettings();
    });
  },

  // FR-TAN-19: Settings ▸ Display 의 `프로세스 이름을 탭 이름으로`. 기본은 켬.
  //
  // 값이 서버에 있는 이유는 FR-TAN-18 이다 — `dmctl list-workspace` 가 화면과
  // 같은 이름을 내려면 표시 규칙에 진실이 하나여야 하고, 브라우저 탭별 저장
  // (displayMode 가 쓰는 sessionStorage)으로는 그것이 서지 않는다.
  _initFgNames(){
    const cb=document.getElementById('ds-fgnames');
    if(!cb) return;
    cb.checked=fgTabNames;
    cb.addEventListener('change',()=>{
      fgTabNames=cb.checked;
      // FR-TAN-20: 끄면 **즉시** 전 탭이 기본 이름(또는 수동 이름)으로 돌아간다.
      // 켜면 이미 들고 있는 파생 이름이 그대로 다시 보인다 — 다음 조회를
      // 기다릴 필요가 없다.
      this._fgRepaint();
      this.saveSettings();
    });
  },

  /**
   * FR-KEY-6: Settings ▸ Shortcuts 의 `브라우저 기본 단축키 차단`.
   *
   * 값이 서버에 있는 이유는 `fgTabNames` 와 같다 — 단축키 자체가 서버 설정이고,
   * 그 단축키가 실제로 먹히는지를 정하는 스위치가 다른 곳에 살면 두 값이
   * 브라우저마다 어긋난다.
   */
  _initBlockKeys(){
    const cb=document.getElementById('sc-blockbrowser');
    if(!cb) return;
    cb.checked=blockBrowserKeys;
    cb.addEventListener('change',()=>{
      blockBrowserKeys=cb.checked;
      this.saveSettings();
    });
  },

  /**
   * FR-LVC-1·10: Settings ▸ Display 의 `떠날 때 확인`.
   *
   * 값이 서버에 있는 이유는 `blockBrowserKeys` 와 같다 (D-2). 자리가 Display 인
   * 이유는 D-3 이다 — 저쪽은 **키**를 다루고 이쪽은 떠남의 동작이다.
   *
   * 가드가 이 전역을 그때그때 읽으므로 리스너를 다시 걸 일이 없다 (FR-LVC-10).
   */
  _initConfirmLeave(){
    const cb=document.getElementById('ds-confirmleave');
    if(!cb) return;
    cb.checked=confirmLeave;
    cb.addEventListener('change',()=>{
      confirmLeave=cb.checked;
      this.saveSettings();
    });
  },

  /**
   * UNFOCUSED_EDGE_SRS FR-UFE-10·11: Settings ▸ Display 의 `포커스 잃은 창 표시`.
   *
   * 바꾼 값은 **그 자리에서** 화면에 닿는다 (`_paintFocusEdge`). 저장만 하고
   * 다음 로드로 미루면 사용자는 스위치가 듣지 않는 것으로 읽는다 —
   * `fgTabNames` 가 `_fgRepaint` 를 부르는 것과 같은 이유다.
   */
  /**
   * UNFOCUSED_EDGE_SRS FR-UFE-10·11·16: Settings ▸ Display 의 `포커스 잃은 창 표시`.
   *
   * 손잡이가 하나다 (D-4a): 0 이 곧 끔이므로 스위치를 따로 두지 않는다.
   * 바꾼 값은 **그 자리에서** 화면에 닿는다 — 저장만 하고 다음 로드로 미루면
   * 사용자는 손잡이가 듣지 않는 것으로 읽는다 (`fgTabNames` 와 같은 이유).
   */
  _initFocusEdge(){
    const sl=document.getElementById('ds-focusedge');
    if(!sl) return;
    sl.max=UFE_LEVEL_MAX;
    this._focusEdgePaintRow();
    // FR-UFE-16: 움직이는 대로 화면이 따라야 고른 것을 볼 수 있다. 저장은 멎은
    // 뒤 한 번이다 — `tabWidthPx` 와 같은 근거(한 번의 드래그가 수십 번의 PUT).
    sl.addEventListener('input',()=>{
      focusEdgeLevel=Number(sl.value);
      this._focusEdgePaintRow();
      this._attnEdgePaintRow();
      this._paintFocusEdge();
      this._focusEdgePreview();
      TIMERS.cancel(this._ufeSaveTimer);
      this._ufeSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-ufe'});
    });
    // 손을 떼는 순간이 값이 정해지는 순간이다 — 그때는 기다리지 않고 보낸다.
    // `tabWidthPx` 가 `blur` 에서 하는 것과 같은 자리다: 디바운스는 드래그 **중**의
    // PUT 폭주를 막으려는 것이지, 정해진 값을 늦추려는 것이 아니다.
    sl.addEventListener('change',()=>{
      TIMERS.cancel(this._ufeSaveTimer);
      this.saveSettings();
    });
  },

  /**
   * ALERT_MOBILE_CONTEXT_SRS FR-AED-8·10·12: 알림 가장자리의 세기.
   *
   * 손잡이도 규약도 포커스 표시와 같다 (FR-UFE-16 의 근거 그대로: 움직이는 대로
   * 화면이 따라야 고른 것을 볼 수 있고, 저장은 멎은 뒤 한 번이다). 다른 것은
   * **미리보기의 이유**다 — 저쪽은 창이 포커스를 가진 동안 보이지 않아서이고,
   * 이쪽은 알림이 없는 동안 보이지 않아서다.
   */
  _initAttnEdge(){
    const sl=document.getElementById('ds-attnedge');
    if(!sl) return;
    sl.max=ATTN_EDGE_LEVEL_MAX;
    this._attnEdgePaintRow();
    sl.addEventListener('input',()=>{
      attnEdgeLevel=Number(sl.value);
      this._attnEdgePaintRow();
      this._paintAttnEdge();
      this._attnEdgePreview();
      // 세기를 0 으로 내리면 지금 켜져 있던 띠도 그 자리에서 꺼져야 한다.
      this._attnRefresh();
      TIMERS.cancel(this._aeSaveTimer);
      this._aeSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-ae'});
    });
    sl.addEventListener('change',()=>{
      TIMERS.cancel(this._aeSaveTimer);
      this.saveSettings();
    });
  },

  // FR-AED-11: 0 은 숫자가 아니라 상태다 — `끔` 이라 적는다.
  _attnEdgePaintRow(){
    const sl=document.getElementById('ds-attnedge');
    const out=document.getElementById('ds-attnedge-val');
    if(!sl) return;
    sl.value=attnEdgeLevel;
    sl.style.setProperty('--fill',(attnEdgeLevel/ATTN_EDGE_LEVEL_MAX*100)+'%');
    if(out) out.textContent=attnEdgeLevel?String(attnEdgeLevel):UFE_LEVEL_OFF_LABEL;
  },

  // FR-AED-12: 고르는 동안 보인다. 알림이 없어도 — 없을 때가 대부분이다.
  _attnEdgePreview(){
    const ds=document.documentElement;
    TIMERS.cancel(this._aePreviewTimer);
    if(!attnEdgeLevel){ds.classList.remove(ATTN_EDGE_PREVIEW_CLASS);return}
    ds.classList.add(ATTN_EDGE_PREVIEW_CLASS);
    this._aePreviewTimer=this.timers.after(ATTN_EDGE_PREVIEW_MS,
      ()=>ds.classList.remove(ATTN_EDGE_PREVIEW_CLASS),{owner:'app',label:'ae-preview'});
  },

  // FR-UFE-14·15 / FR-SCT-8: 레인지와 그 값 표시, 채움 비율을 함께 되돌린다.
  // 0 은 숫자가 아니라 상태이므로 `끔` 이라 적는다 (SETTINGS_CONTROLS_SRS D-7).
  _focusEdgePaintRow(){
    const sl=document.getElementById('ds-focusedge');
    const out=document.getElementById('ds-focusedge-val');
    if(!sl) return;
    sl.value=focusEdgeLevel;
    sl.style.setProperty('--fill',(focusEdgeLevel/UFE_LEVEL_MAX*100)+'%');
    if(out) out.textContent=focusEdgeLevel?String(focusEdgeLevel):UFE_LEVEL_OFF_LABEL;
  },

  /**
   * FR-UFE-18 / D-8d: 고르는 동안 보인다.
   *
   * 이 표시는 포커스를 잃었을 때만 뜨는데, 레인지를 만지는 동안 창은 **반드시**
   * 포커스를 가지고 있다. 미리보기가 없으면 사용자는 눈을 감고 값을 고른다.
   * 0 에서는 보여 줄 것이 없으므로 켜지 않는다.
   */
  _focusEdgePreview(){
    const ds=document.documentElement;
    TIMERS.cancel(this._ufePreviewTimer);
    if(!focusEdgeLevel){ds.classList.remove(UFE_PREVIEW_CLASS);return}
    ds.classList.add(UFE_PREVIEW_CLASS);
    this._ufePreviewTimer=this.timers.after(UFE_PREVIEW_MS,()=>ds.classList.remove(UFE_PREVIEW_CLASS),{owner:'app',label:'ufe-preview'});
  },

  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-10·11: Settings ▸ Code 의 `줄 바꿈`.
   *
   * **이미 열려 있는 편집기에도 곧바로 반영한다** — 새로 여는 탭부터 듣게 하면
   * 사용자는 설정이 고장난 것으로 읽는다. 옵션 갱신이지 편집기 재생성이 아니므로
   * 편집 중인 내용과 커서를 잃지 않는다 (NFR-WBR-1).
   */
  _initWordWrap(){
    const cb=document.getElementById('ds-wordwrap');
    if(!cb) return;
    cb.checked=editorWordWrap;
    cb.addEventListener('change',()=>{
      editorWordWrap=cb.checked;
      this._edApplyWordWrap();
      this.saveSettings();
    });
  },

  /**
   * 열려 있는 편집기 전부에 지금 값을 얹는다.
   *
   * 살아 있는 인스턴스의 목록은 `app.fileEditors` 다 (`renderer.js:533` 이 만들고
   * `app-layout.js:428` 이 거둔다). `monaco.editor.getEditors()` 를 쓰지 않는
   * 이유는 그것이 **diff 뷰 안의 편집기까지** 주기 때문이다 — 그쪽은 비목표다.
   */
  _edApplyWordWrap(){
    if(!this.fileEditors) return;
    for(const ed of this.fileEditors.values()) if(ed&&ed.applyWordWrap) ed.applyWordWrap();
  },

  // ── Modal & Theme ──
});
