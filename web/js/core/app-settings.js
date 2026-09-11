/**
 * Remote Terminal — App 설정 모달·테마 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 9개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  async _saveSettings(){
    // 블롭 전체를 갈아치우므로 읽어 쓰는 값은 전부 실어야 한다 — 여기서 빠지면
    // 다른 설정을 건드릴 때 조용히 사라진다.
    //
    // POLL_INTERVAL_SETTINGS_SRS FR-PIS-6: 주기 다섯이 나란히 실린다.
    // `gitSignatureInterval` 은 **빠졌다** — 읽을 계층이 없으므로 실어도 아무
    // 일도 하지 않고, 남기면 지운 계층이 아직 있다고 읽힌다 (FR-PIS-2).
    // `FE-7`(PRODUCTION_ROADMAP §M3): **응답을 검사한다.** 종전에는 결과를
    // 버렸고, 그래서 디스크가 차거나 경계에 걸려 거절된 저장이 **성공처럼**
    // 보였다 — 사용자는 설정이 바뀐 줄 알고 다음 기동에서 옛 값을 만난다.
    const res=await apiPut('/api/settings',{themeName:customTheme?null:currentThemeName,customTheme,shortcuts,statusBar,agentsPollInterval,statsInterval,gitStatusInterval,gitReposInterval,gitConsoleInterval,layoutPresets,defaultPreset,fgTabNames,blockBrowserKeys,pageTitle,confirmLeave,editorWordWrap,tabFixedWidth,tabWidthPx,focusEdgeLevel,attnEdgeLevel});
    if(!res.ok&&this._notify) this._notify(SETTINGS_SAVE_FAIL);
    return res.ok;
  },

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
      this._titleSaveTimer=this.timers.after(500,()=>this._saveSettings(),{owner:'app',label:'save-title'});
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
      this._saveSettings();
    });
    num.addEventListener('input',()=>{
      // FR-TBW-4: 자르는 것은 적용하는 값뿐이다 — 입력란의 글자를 그때그때
      // 고쳐 쓰면 타이핑이 튄다 (`160` 을 지우고 `9` 를 치는 순간 `40` 이 된다).
      tabWidthPx=clampTabWidth(num.value);
      applyTabWidth();
      TIMERS.cancel(this._tabwSaveTimer);
      this._tabwSaveTimer=this.timers.after(500,()=>this._saveSettings(),{owner:'app',label:'save-tabw'});
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
      this._saveSettings();
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
      this._saveSettings();
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
      this._saveSettings();
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
      this._saveSettings();
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
      this._ufeSaveTimer=this.timers.after(500,()=>this._saveSettings(),{owner:'app',label:'save-ufe'});
    });
    // 손을 떼는 순간이 값이 정해지는 순간이다 — 그때는 기다리지 않고 보낸다.
    // `tabWidthPx` 가 `blur` 에서 하는 것과 같은 자리다: 디바운스는 드래그 **중**의
    // PUT 폭주를 막으려는 것이지, 정해진 값을 늦추려는 것이 아니다.
    sl.addEventListener('change',()=>{
      TIMERS.cancel(this._ufeSaveTimer);
      this._saveSettings();
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
      this._aeSaveTimer=this.timers.after(500,()=>this._saveSettings(),{owner:'app',label:'save-ae'});
    });
    sl.addEventListener('change',()=>{
      TIMERS.cancel(this._aeSaveTimer);
      this._saveSettings();
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
      this._saveSettings();
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

  /**
   * SANDBOX_PICK_COPY_SRS FR-SPK-7: 설정 화면을 특정 탭으로 연다.
   *
   * **버튼과 탭을 실제로 누른다.** 여는 절차(패널 다시 칠하기·모바일 드로어
   * 닫기·탭별 재조회)가 그 리스너 안에 있으므로, 여기서 클래스만 바꾸면 그
   * 절차가 통째로 빠진 반쯤 열린 화면이 된다.
   */
  _openSettings(tab){
    const btn=document.getElementById('settings-btn');
    if(btn) btn.click();
    if(!tab) return;
    const t=document.querySelector('#modal .mtab[data-tab="'+tab+'"]');
    if(t) t.click();
  },

  /**
   * 서버 설정 blob 하나를 **화면에 얹는다** (SETTINGS_LIVE: 2026-09-08 접수).
   *
   * 종전에는 이 일이 두 곳에 흩어져 있었다 — `main.js` 의 부팅 로더(테마·단축키·
   * 상태바·주기·프리셋·제목)와 이 파일 끝의 IIFE(브라우저 키·떠날 때 확인·
   * 가장자리·줄바꿈·탭 너비·프로세스 이름). 둘 다 키를 손으로 나열했고, 그래서
   * **다른 창에서 바뀐 값을 받아 얹을 자리가 아예 없었다**: 접수한 말이
   * "설정값이 바뀌었을 때 다른 브라우저창은 바로 갱신이 안된다" 다.
   *
   * 얹는 규약을 한 함수로 내리면 세 계기가 같은 길을 지난다 — 부팅 · SSE 방송 ·
   * 소프트 리로드. 새 설정을 더할 때 고칠 자리도 하나다.
   *
   * `boot` 는 **부팅에서만 해야 하는 일**을 가른다. 지금은 그런 것이 없지만,
   * 값을 지우는 쪽(예: `saved.x===undefined` 일 때 기본으로 되돌리기)은 부팅과
   * 갱신에서 뜻이 다를 수 있어 자리를 비워 둔다.
   */
  _settingsApply(saved,opts){
    if(!saved||typeof saved!=='object') return;
    if(saved.shortcuts) Object.assign(shortcuts,saved.shortcuts);
    if(saved.statusBar) Object.assign(statusBar,saved.statusBar);
    /**
     * POLL_INTERVAL_SETTINGS_SRS FR-PIS-7·8: **주기 다섯이 여기 한 자리를 지난다.**
     *
     * 부팅 · SSE `settings_changed` · 소프트 리로드가 같은 길이므로 새 전파 경로가
     * 생기지 않는다 (D-4). 값의 검사도 여기 하나다 — 손으로 고친 `settings.json`
     * 하나가 초당 폴링을 만들지 않아야 한다 (FR-UFE-12·13 과 같은 근거).
     */
    // FR-GIT-23 의 `0`(그 계층을 걸지 않는다)은 예외가 아니라 **표 안에** 있다 —
    // `off:true` 를 가진 주기만 0 을 통과시킨다 (FR-PIS-9).
    //
    // `!==undefined` 가드는 **이 파일의 다른 설정 전부와 같은 규약**이다 (FR-PIS-8):
    // 서버가 말하지 않은 키에 대해 화면이 판단하지 않는다. 부팅에서는 변수가 이미
    // 상수 기본값이라 결과가 같고, 갱신에서는 이것이 유일하게 안전한 답이다 —
    // 되돌려 버리면 이 자리에 값을 직접 넣어 둔 쪽(검사·진단)의 값을 방송 하나가
    // 지운다. 위 주석의 "`saved.x===undefined` 일 때 기본으로 되돌리기는 부팅과
    // 갱신에서 뜻이 다르다" 가 정확히 이 자리다.
    for(const spec of POLL_SETTINGS)
      if(saved[spec.key]!==undefined) spec.set(pollValue(saved[spec.key],spec));
    if(saved.layoutPresets) layoutPresets=saved.layoutPresets;
    if(saved.defaultPreset!==undefined) defaultPreset=saved.defaultPreset;
    // 테마는 둘 중 하나다 — 사용자 정의가 있으면 그것이 이긴다.
    if(saved.customTheme){customTheme=saved.customTheme;applyThemeObj(customTheme)}
    else if(saved.themeName&&THEMES[saved.themeName]){customTheme=null;currentThemeName=saved.themeName;applyThemeObj(THEMES[currentThemeName])}
    // PAGE_TITLE_SRS FR-PGT-10
    if(saved.pageTitle!==undefined){pageTitle=saved.pageTitle;this._applyPageTitle()}
    // FR-KEY-6: 저장된 적 없으면 기본값(켬).
    if(saved.blockBrowserKeys!==undefined){
      blockBrowserKeys=!!saved.blockBrowserKeys;
      const bk=document.getElementById('sc-blockbrowser');
      if(bk) bk.checked=blockBrowserKeys;
    }
    // FR-LVC-6: 저장된 적 없으면 기본값(끔).
    if(saved.confirmLeave!==undefined){
      confirmLeave=!!saved.confirmLeave;
      const cl=document.getElementById('ds-confirmleave');
      if(cl) cl.checked=confirmLeave;
    }
    // FR-UFE-12·13: 범위 밖이거나 정수가 아닌 값은 받지 않는다 — 손으로 고친
    // settings.json 하나가 화면을 통째로 반전시키는 일이 없어야 한다.
    if(saved.focusEdgeLevel!==undefined){
      const lv=Math.round(Number(saved.focusEdgeLevel));
      if(lv>=0&&lv<=UFE_LEVEL_MAX) focusEdgeLevel=lv;
      this._focusEdgePaintRow();
      this._paintFocusEdge();
    }
    // FR-AED-9: 같은 규약, 다른 키 (D-9). 범위 밖은 기본값으로 떨어진다.
    if(saved.attnEdgeLevel!==undefined){
      const lv=Math.round(Number(saved.attnEdgeLevel));
      attnEdgeLevel=(lv>=0&&lv<=ATTN_EDGE_LEVEL_MAX)?lv:ATTN_EDGE_LEVEL_DEFAULT;
      this._attnEdgePaintRow();
      this._paintAttnEdge();
      this._attnRefresh();
    }
    // FR-WBR-10·11: 값만 바꾸면 사용자는 설정이 듣지 않는 것으로 읽는다 —
    // 이미 열려 있는 편집기에도 얹는다.
    if(saved.editorWordWrap!==undefined){
      editorWordWrap=!!saved.editorWordWrap;
      const ww=document.getElementById('ds-wordwrap');
      if(ww) ww.checked=editorWordWrap;
      if(this._edApplyWordWrap) this._edApplyWordWrap();
    }
    // FR-TBW-8: 같은 근거로 곧바로 얹는다. 클래스와 변수 하나뿐이라 다시 그리지 않는다.
    if(saved.tabFixedWidth!==undefined||saved.tabWidthPx!==undefined){
      if(saved.tabFixedWidth!==undefined) tabFixedWidth=!!saved.tabFixedWidth;
      if(saved.tabWidthPx!==undefined) tabWidthPx=clampTabWidth(saved.tabWidthPx);
      const tf=document.getElementById('ds-tabfix');
      if(tf) tf.checked=tabFixedWidth;
      const tw=document.getElementById('ds-tabw');
      if(tw) tw.value=String(tabWidthPx);
      applyTabWidth();
    }
    if(saved.fgTabNames!==undefined){
      fgTabNames=!!saved.fgTabNames;
      if(this._fgRepaint) this._fgRepaint();
      const cb=document.getElementById('ds-fgnames');
      if(cb) cb.checked=fgTabNames;
    }
    // 설정 변경은 감지 계층의 재평가 시점이다 (FR-GIT-23). 이 계층만 따로인
    // 이유는 백오프·소실 판정·활성 저장소 판정을 함께 쥐고 있어 주기만 떼어 올
    // 수 없기 때문이다 (FR-PIS-15).
    if(this.gitPanel&&this.gitPanel._reschedule) this.gitPanel._reschedule();
    /**
     * FR-PIS-14 / D-8a: 나머지 주기는 **도는 타이머에 닿아야** 한다.
     *
     * 진입점이 하나인 이유는 핸들에 닿는 길이 저마다 다르기 때문이다 — git
     * 콘솔의 타이머는 `observer → panels → panel._consoleView` 세 단 아래에 있고,
     * 그 길을 설정이 알아야 할 이유가 없다. 바뀐 job 만 다시 걸리고, **발화하지
     * 않는다**: 주기를 바꾼 것은 수집의 계기가 아니다.
     */
    TIMERS.refreshChanged();
    // 화면의 드롭다운도 같은 값을 보여야 한다 — 다른 창에서 바뀐 값이 SSE 로
    // 왔을 때 열려 있는 설정창이 옛 값을 든 채 남지 않는다 (FR-SYN).
    if(this._pollPaintRows) this._pollPaintRows();
    /**
     * FR-PIS-17 / D-9: `agentsPollMs` 의 이사는 **부팅에서만** 한다.
     *
     * `boot` 가 가르는 자리가 바로 이런 것이라고 위 주석이 적어 두었다 — SSE
     * 방송마다 로컬을 다시 보면, 그 사이 다른 창에서 바꾼 값을 옛 로컬 값이
     * 덮는다. 이사는 한 번이고 조용하다.
     */
    if(opts&&opts.boot) this._pollMigrateAgents(saved);
  },

  /**
   * 서버의 설정을 다시 받아 얹는다. `STATE_REGISTRY` 의 `settings` 가 부른다 —
   * 계기는 셋이다: SSE `settings_changed` · 구독이 열린 순간 · 소프트 리로드.
   *
   * `merge:'latest'` 인 이유는 이 상태에 **증분이 없기** 때문이다 (FR-HUB 의
   * `background` 와 같은 근거) — 방송은 "다시 받으라" 는 신호이고, 막아야 하는
   * 것은 스냅샷끼리의 추월뿐이다.
   */
  _settingsRestore(){
    const t=this._restoreBegin('settings');
    return apiGet('/api/settings').then(r=>{
      if(!this._restoreLive('settings',t)) return;
      this._settingsApply(r.ok?r.data:null);
      this._restoreEnd('settings',t);
    });
  },

  _initModal(){
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    document.getElementById('settings-btn').addEventListener('click',()=>{
      overlay.classList.add('open');
      this._renderThemePanel();this._renderShortcutList();this._renderPresets();
      const dsMode=document.getElementById('ds-mode');
      const dsBp=document.getElementById('ds-bp');
      if(dsMode) dsMode.value=this.displayMode;
      if(dsBp) dsBp.value=this.mobileBreakpoint;
      const dsTitle=document.getElementById('ds-title');
      if(dsTitle) dsTitle.value=pageTitle;
      const dsFg=document.getElementById('ds-fgnames');
      if(dsFg) dsFg.checked=fgTabNames;
      // FR-WSL-81: 슬롯 방향 세그먼트. 열 때마다 현재 값을 다시 칠한다.
      this._slotDirPaint();
      const scBlock=document.getElementById('sc-blockbrowser');
      if(scBlock) scBlock.checked=blockBrowserKeys;
      // FR-LVC-3: 열 때마다 현재 값을 다시 칠한다 — 다른 화면에서 바뀐 값이
      // 이 모달에 옛 상태로 남아 있으면 사용자가 그것을 켜진 줄로 읽는다.
      const dsLeave=document.getElementById('ds-confirmleave');
      if(dsLeave) dsLeave.checked=confirmLeave;
      // FR-UFE-14: 같은 근거로 이 행도 열 때마다 다시 칠한다 — 체크박스와 세기가
      // 함께 움직이므로 한 함수가 둘을 맡는다.
      this._focusEdgePaintRow();
      // FR-WBR-10: 열 때마다 현재 값을 다시 칠한다 (FR-LVC-3 과 같은 근거).
      const dsWrap=document.getElementById('ds-wordwrap');
      if(dsWrap) dsWrap.checked=editorWordWrap;
      // Auto-close drawer when opening settings on mobile
      if(this.isMobile && this._drawerOpen){this._toggleDrawer(false);this.renderer._rTopbar()}
    });
    document.getElementById('modal-close').addEventListener('click',()=>overlay.classList.remove('open'));
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open')});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('open')){e.preventDefault();overlay.classList.remove('open')}});
    modal.querySelectorAll('.mtab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        modal.querySelectorAll('.mtab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelectorAll('.mpanel').forEach(p=>p.style.display='none');
        document.getElementById('panel-'+tab.dataset.tab).style.display='';
        if(tab.dataset.tab==='presets')this._renderPresets();
        // 샌드박스 정의는 파일이 진실이다. 열 때마다 다시 읽어야 바깥에서
        // 고친 것과 어긋나지 않는다.
        if(tab.dataset.tab==='sandbox')this._loadSandboxPanel();
        // 허용 목록도 파일이 진실이다. 게다가 해석 상태는 관측값이라 캐시할
        // 수 없다 — 열 때마다 서버에 묻는다.
        if(tab.dataset.tab==='access')this._loadAccessPanel();
        // FR-LSP-47: 언어 서버의 상태는 캐시가 아니라 관측이다 — 샌드박스와
        // 같은 근거로 열 때마다 다시 읽는다.
        if(tab.dataset.tab==='code'){
          this._lspRefresh();
          // 토글은 기기별 값이라 다른 탭에서 바뀔 일이 없지만, 열 때마다 다시
          // 칠하는 것이 이 모달의 규약이다 (FR-LVC-3 와 같은 근거).
          const dcb=document.getElementById('lsp-diag');
          if(dcb) dcb.checked=lspDiagOn;
        }
      });
    });
    this._initPageTitle();
    this._initTabWidth();
    this._initFgNames();
    this._initBlockKeys();
    this._initConfirmLeave();
    this._initFocusEdge();
    this._initAttnEdge();
    this._initWordWrap();
    this._initLSP();
    this._initBackup();
    this._initSandboxPanel();
    this._initAccessPanel();
  },

  _renderThemePanel(){
    const list=document.getElementById('theme-list'); list.innerHTML='';
    const activeName=customTheme?null:currentThemeName;
    const groups={dark:[],light:[]};
    for(const name of Object.keys(THEMES)){
      const t=THEMES[name];
      (t.mode==='light'?groups.light:groups.dark).push(name);
    }
    const renderGroup=(label,names)=>{
      if(!names.length) return;
      const hdr=document.createElement('div');
      hdr.className='tl-section'; hdr.textContent=label;
      list.appendChild(hdr);
      for(const name of names){
        const t=THEMES[name];
        const item=document.createElement('div');
        item.className='tl-item'+(name===activeName?' active':'');
        // 색 점과 이름을 **DOM 으로 세운다.** 종전에는 마크업 문자열을 이어
        // 붙였고, `t.ui[k]` 와 `name` 은 사용자가 만든 테마에서 온다 — 문자열
        // 조립은 그 값들이 마크업이 되는 길이었다.
        const keys=['bg','accent','text','border','danger'];
        const dots=document.createElement('div');
        dots.className='tl-dots';
        for(const k of keys){
          const dot=document.createElement('span');
          dot.style.background=t.ui[k];
          dots.appendChild(dot);
        }
        const label=document.createElement('span');
        label.className='tl-name';
        label.textContent=name;
        item.appendChild(dots); item.appendChild(label);
        item.addEventListener('click',()=>{
          currentThemeName=name; customTheme=null;
          applyThemeObj(t); this._renderThemePanel(); this._hideCustomEditor();
          this._saveSettings();
        });
        list.appendChild(item);
      }
    };
    renderGroup('Dark', groups.dark);
    renderGroup('Light', groups.light);
    this._renderPreview();
  },

  _renderPreview(){
    const t=getCurrentTheme();
    const u=t.ui, tr=t.terminal;
    const ah=hexToRgba(u.accent,.08);
    const c=tr; // shorthand
    document.getElementById('theme-preview').innerHTML=`
    <div style="display:flex;height:100%">
      <div class="pv-sidebar" style="background:${u.sidebarBg};border-right:1px solid ${u.border}">
        <div style="font-size:6px;color:${u.textMuted};padding:4px 2px;letter-spacing:.05em">SESSIONS</div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px">
          <div class="pv-dot" style="background:${u.accent}"></div>
          <span style="font-size:7px;color:${u.textBright}">Main</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto">×</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px;background:${ah}">
          <div class="pv-dot" style="background:${u.accent}"></div>
          <span style="font-size:7px;color:${u.textBright};font-weight:600">Work</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto">×</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px">
          <div class="pv-dot" style="background:${u.textDim}"></div>
          <span style="font-size:7px;color:${u.text}">Test</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto;opacity:.4">×</span>
        </div>
      </div>
      <div class="pv-main" style="background:${u.bg}">
        <div class="pv-topbar" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
          <span style="color:${u.text}">Work</span>
          <span style="flex:1"></span>
          <span style="color:${u.textMuted};font-size:7px;border:1px solid ${u.accentBorder};border-radius:2px;padding:0 3px">Split H</span>
          <span style="color:${u.accent};font-size:7px;border:1px solid ${u.accentBorder};border-radius:2px;padding:0 3px">Split V</span>
        </div>
        <div class="pv-split">
          <div class="pv-split-left" style="border:2px solid ${u.accent}">
            <div class="pv-tabs" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
              <div class="pv-tab" style="color:${u.textMuted};border-right:1px solid ${u.border}">Shell <span style="color:${u.danger}">×</span></div>
              <div class="pv-tab" style="color:${u.textBright};background:${ah};border-bottom:1px solid ${u.accent}">vim <span style="color:${u.danger}">×</span></div>
            </div>
            <div class="pv-term" style="background:${c.background};color:${c.foreground}">
              <span style="color:${c.green}">$</span> <span style="color:${c.cyan}">echo</span> <span style="color:${c.yellow}">"palette"</span><br>
              <span style="background:${c.selectionBackground};color:${c.selectionForeground}">selected text here █</span><br>
              <span style="color:${c.red}">● Red</span> <span style="color:${c.green}">● Grn</span> <span style="color:${c.yellow}">● Ylw</span> <span style="color:${c.blue}">● Blu</span><br>
              <span style="color:${c.magenta}">● Mag</span> <span style="color:${c.cyan}">● Cyn</span> <span style="color:${c.white}">● Wht</span> <span style="color:${c.brightBlack}">● Bk</span><br>
              <span style="color:${c.brightRed}">● BR</span> <span style="color:${c.brightGreen}">● BG</span> <span style="color:${c.brightYellow}">● BY</span> <span style="color:${c.brightBlue}">● BB</span><br>
              <span style="color:${c.brightMagenta}">● BM</span> <span style="color:${c.brightCyan}">● BC</span> <span style="color:${c.brightWhite}">● BW</span> <span style="color:${c.black}">● Bk</span>
            </div>
          </div>
          <div style="width:3px;background:${u.border}"></div>
          <div class="pv-split-right" style="border:1px solid ${u.border}">
            <div class="pv-tabs" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
              <div class="pv-tab" style="color:${u.textBright};background:${ah};border-bottom:1px solid ${u.accent}">htop <span style="color:${u.danger}">×</span></div>
              <div class="pv-tab" style="color:${u.textMuted};border-left:1px solid ${u.border}">Shell <span style="color:${u.danger}">×</span></div>
            </div>
            <div class="pv-term" style="background:${c.background};color:${c.foreground}">
              <span style="color:${c.cyan}">PID</span> <span style="color:${c.green}">CPU</span> <span style="color:${c.yellow}">MEM</span> <span style="color:${c.blue}">CMD</span><br>
              <span style="color:${c.foreground}"> 1  </span><span style="color:${c.green}">  2% </span><span style="color:${c.yellow}">  1% </span><span style="color:${c.foreground}">bash</span><br>
              <span style="color:${c.foreground}"> 42 </span><span style="color:${c.red}"> 99% </span><span style="color:${c.red}"> 45% </span><span style="color:${c.foreground}">node</span><br>
              <br>
              <span style="color:${c.foreground}">cursor: </span><span style="background:${c.cursor};color:${c.cursorAccent}"> █ </span>
            </div>
          </div>
        </div>
        <div class="pv-status" style="background:${u.sidebarBg};border-top:1px solid ${u.border}">
          <span style="color:${u.accent}">●</span>
          <span style="color:${u.textMuted};margin-left:4px">2 windows · 3 panes</span>
          <span style="margin-left:auto;color:${u.danger};font-size:7px">ERR</span>
          <span style="margin-left:4px;color:${u.text};font-size:7px">OK</span>
        </div>
      </div>
    </div>`;
  },

  _hideCustomEditor(){
    document.getElementById('custom-editor').style.display='none';
    document.getElementById('custom-toggle').classList.remove('active');
  },

  _showCustomEditor(){
    const base=getCurrentTheme();
    customTheme=JSON.parse(JSON.stringify(base));
    document.getElementById('custom-toggle').classList.add('active');
    document.getElementById('custom-editor').style.display='';
    // UI colors
    const uiDiv=document.getElementById('ce-ui'); uiDiv.innerHTML='';
    for(const [key,label] of Object.entries(UI_LABELS)){
      uiDiv.appendChild(this._colorInput(key,label,customTheme.ui));
    }
    // Terminal colors
    const termDiv=document.getElementById('ce-terminal'); termDiv.innerHTML='';
    for(const [key,label] of Object.entries(TERM_LABELS)){
      termDiv.appendChild(this._colorInput(key,label,customTheme.terminal));
    }
  },

  _colorInput(key,label,obj){
    const item=document.createElement('div'); item.className='ce-item';
    const lbl=document.createElement('label'); lbl.textContent=label;
    const inp=document.createElement('input'); inp.type='color'; inp.value=obj[key]||'#000000';
    inp.addEventListener('input',()=>{
      obj[key]=inp.value;
      applyThemeObj(customTheme);
      this._renderPreview();
      this._saveSettings();
    });
    item.appendChild(lbl); item.appendChild(inp);
    return item;
  },

  _renderShortcutList(){
    const el=document.getElementById('sc-list');if(!el)return;
    el.innerHTML='';
    const groups=[
      {label:'창',keys:['windowNext','windowPrev','newWindow','closeWindow']},
      {label:'탭',keys:['tabNext','tabPrev','newTab','closeTab']},
      {label:'Pane',keys:['paneUp','paneDown','paneLeft','paneRight']},
      // FR-WSL-51: 창 **안**의 분할과 창 **밖**의 슬롯은 다른 것이다 (§7 R-3).
      // 같은 그룹에 두되 라벨이 그 차이를 말한다.
      {label:'분할',keys:['splitH','splitV','slotAdd','slotRemove','slotPrev','slotNext']},
      // PANEL_SHORTCUTS_SRS FR-PSC-5: 상단 툴바의 진입점 셋. 목록의 차례를
      // 툴바의 차례(Runs · Background · Agents)와 맞춘다.
      {label:'패널',keys:['runsToggle','bgToggle','agentsToggle','sidebarToggle']},
      {label:'새로고침',keys:['softReload']},
      // EDITOR_GIT_UX_SRS FR-EKB-5: 편집기의 검색 셋. 좁은 것부터 넓은 것으로
      // 늘어놓는다 — 파일 안 → 파일 이름 → 파일 내용 전체.
      {label:'Editor 검색',keys:['edFindInFile','edQuickOpen','edGrep']},
      // FR-SBT-21·30: 직행 키는 서술자 배열에서 파생한다 — 탭이 늘어도 이 목록을
      // 손으로 늘리지 않는다.
      {label:'사이드바 탭',keys:SB_TAB_DEFS.slice(0,9).map((d,i)=>sbTabAction(i))},
    ];
    for(const g of groups){
      const title=document.createElement('div');title.className='sc-group-title';title.textContent=g.label;
      el.appendChild(title);
      for(const k of g.keys){
        const row=document.createElement('div');row.className='sc-row';
        const label=document.createElement('span');label.textContent=SHORTCUT_LABELS[k];
        const btn=document.createElement('button');btn.className='sc-key';btn.dataset.action=k;
        btn.textContent=displayKey(shortcuts[k]||'');
        // FR-TIP-1: 키 조합이 라벨이므로 **누르면 무슨 일이 나는지**는 라벨에 없다.
        btn.title=SHORTCUT_REBIND_TITLE;
        // Click → record mode
        btn.addEventListener('click',()=>{
          this._cancelRecording();
          this._recording=k;btn.textContent='키를 누르세요...';btn.classList.add('recording');
        });
        const rst=UIKit.button({icon:'undo',title:SHORTCUT_RESET_TITLE,kind:'ghost',size:'sm',cls:'sc-rst'});
        rst.addEventListener('click',()=>{shortcuts[k]=SHORTCUT_DEFAULTS[k];this._saveSettings();btn.textContent=displayKey(shortcuts[k])});
        row.appendChild(label);
        const btns=document.createElement('div');btns.className='sc-btns';
        btns.appendChild(btn);btns.appendChild(rst);
        row.appendChild(btns);
        el.appendChild(row);
      }
    }
  },
  _cancelRecording(){
    if(!this._recording)return;
    const btn=document.querySelector('.sc-key.recording');
    if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
    this._recording=null;
  },
});

/**
 * 샌드박스 설정 (SANDBOX_WINDOW_SRS FR-SBX-43).
 *
 * 기본 마운트는 손으로 적기에 실수하기 쉬운 값이다 — 경로 두 개와 두 개의
 * 표식이 한 항목을 이룬다. 그래서 파일을 직접 고치게 두지 않고 여기서 다룬다.
 */
Object.assign(App.prototype, {
  _sbxMountRow(m={}){
    const row=document.createElement('div');row.className='sbx-mount';
    const mk=(cls,ph,val)=>{
      const i=document.createElement('input');
      i.type='text';i.className=cls;i.placeholder=ph;i.value=val||'';
      return i;
    };
    const host=mk('sbx-host','~/.ssh',m.host);
    const cont=mk('sbx-cont','/root/.ssh',m.container);
    const flag=(label,title,on)=>{
      const l=document.createElement('label');l.className='sbx-flag';l.title=title;
      const c=document.createElement('input');c.type='checkbox';c.checked=!!on;
      const s=document.createElement('span');s.textContent=label;
      l.appendChild(c);l.appendChild(s);return l;
    };
    const ro=flag('ro','읽기 전용으로 붙입니다',m.readonly);
    // 이 표식이 켜지면 그 창은 더 이상 격리 경계가 아니다 (FR-SBX-39b).
    const sc=flag('scratch','격리 창에도 붙입니다 — 켜면 그 창은 격리 경계가 아니게 됩니다',m.scratch);
    const del=UIKit.button({icon:'x',title:'Remove this mount',kind:'ghost',size:'sm',cls:'sbx-del'});
    del.addEventListener('click',()=>row.remove());
    row.append(host,cont,ro,sc,del);
    return row;
  },

  _sbxCollect(){
    const mounts=[];
    for(const row of document.querySelectorAll('#sbx-mounts .sbx-mount')){
      const host=row.querySelector('.sbx-host').value.trim();
      const container=row.querySelector('.sbx-cont').value.trim();
      // 양쪽이 다 빈 줄은 사용자가 추가만 하고 두고 간 것이다 — 조용히 버린다.
      if(!host&&!container) continue;
      const [ro,sc]=row.querySelectorAll('.sbx-flag input');
      mounts.push({host,container,readonly:ro.checked,scratch:sc.checked});
    }
    const image=document.getElementById('sbx-image').value.trim();
    const portsRaw=document.getElementById('sbx-ports').value.trim();
    const cfg={};
    if(mounts.length) cfg.mounts=mounts;
    if(image){
      const ports=portsRaw?portsRaw.split(',').map(s=>s.trim()).filter(Boolean):[];
      cfg.dev=ports.length?{image,ports}:{image};
    }
    return cfg;
  },

  async _loadSandboxPanel(){
    const box=document.getElementById('sbx-mounts');
    const status=document.getElementById('sbx-status');
    if(!box) return;
    box.innerHTML='';status.textContent='';status.classList.remove('err');
    try{
      const r=await apiGet('/api/sandbox/config');
      if(!r.ok){
        // 런타임이 없으면 설정할 대상 자체가 없다. 빈 화면보다 이유가 낫다.
        status.textContent=r.text.trim()||'샌드박스 설정을 읽지 못했습니다';
        status.classList.add('err');
        return;
      }
      const cfg=r.data||{};
      document.getElementById('sbx-image').value=(cfg.dev&&cfg.dev.image)||'';
      document.getElementById('sbx-ports').value=(cfg.dev&&cfg.dev.ports||[]).join(', ');
      for(const m of cfg.mounts||[]) box.appendChild(this._sbxMountRow(m));
    }catch(e){
      status.textContent='샌드박스 설정을 읽지 못했습니다 — '+((e&&e.message)||e);
      status.classList.add('err');
    }
  },

  _initSandboxPanel(){
    const add=document.getElementById('sbx-mount-add');
    const save=document.getElementById('sbx-save');
    if(!add||!save) return;
    add.addEventListener('click',()=>
      document.getElementById('sbx-mounts').appendChild(this._sbxMountRow()));
    save.addEventListener('click',async()=>{
      const status=document.getElementById('sbx-status');
      status.classList.remove('err');status.textContent='저장 중…';
      try{
        const r=await apiPut('/api/sandbox/config',this._sbxCollect());
        if(!r.ok){
          // 거부 사유가 그대로 온다 — 무엇이 잘못됐는지 모르면 고칠 수 없다.
          status.textContent=r.text.trim()||'저장하지 못했습니다';
          status.classList.add('err');
          return;
        }
        status.textContent='저장했습니다';
      }catch(e){
        status.textContent='저장하지 못했습니다 — '+((e&&e.message)||e);
        status.classList.add('err');
      }
    });
  },

  /**
   * ACCESS_ALLOWLIST_SRS 묶음 E — 접속 허용 목록 패널.
   *
   * 이 화면이 잠글 수 있는 것은 **원격 브라우저뿐**이다. 서버가 도는 컴퓨터는
   * 목록과 무관하게 통과하므로(FR-ACL-5) 되돌릴 길이 언제나 남는다. 그래서
   * 저장을 서버가 막지 않고, 여기서 한 걸음 확인만 받는다 (FR-ACL-24).
   */
  _aclRow(e,opts){
    opts=opts||{};
    const row=document.createElement('div');
    row.className='acl-row';
    row.dataset.id=(e&&e.id)||'';
    const on=document.createElement('label');
    on.className='sbx-flag';
    on.title='이 줄을 적용합니다';
    const cb=document.createElement('input');
    cb.type='checkbox';
    cb.checked=e?e.enabled!==false:true;
    on.appendChild(cb);
    const val=document.createElement('input');
    val.type='text';val.className='acl-value';
    val.placeholder=opts.placeholder||'100.117.248.111 · 192.168.0.0/24 · macmini';
    val.value=(e&&e.value)||'';
    const lab=document.createElement('input');
    lab.type='text';lab.className='acl-label';
    lab.placeholder='이름표';
    lab.value=(e&&e.label)||'';
    const st=document.createElement('span');
    st.className='acl-state';
    // FR-ACL-16: 해석 실패가 조용히 지나가면 사용자는 규칙이 걸린 줄 안다.
    // 축②(`plain`)에는 이 칸이 비어 있다 — 별명은 해석하지 않는다 (FR-ACL-34).
    if(opts.plain){/* 해석 상태 없음 */}
    else if(e&&e.error){st.textContent='해석 실패';st.classList.add('err');st.title=e.error}
    else if(e&&e.resolved&&e.resolved.length){st.textContent=e.resolved.join(', ');st.title='해석된 주소'}
    const del=UIKit.button({icon:'x',title:'Remove this entry',kind:'ghost',size:'sm',cls:'sbx-del'});
    del.addEventListener('click',()=>row.remove());
    row.append(on,val,lab,st,del);
    return row;
  },

  _aclRowsIn(sel){
    const out=[];
    for(const row of document.querySelectorAll(sel+' .acl-row')){
      const value=row.querySelector('.acl-value').value.trim();
      // 추가만 하고 두고 간 빈 줄은 조용히 버린다 (마운트 줄과 같은 규약).
      if(!value) continue;
      out.push({
        id:row.dataset.id||(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random()),
        value,
        label:row.querySelector('.acl-label').value.trim(),
        enabled:row.querySelector('input[type=checkbox]').checked,
      });
    }
    return out;
  },

  // FR-ACL-36: `PUT` 은 전체 교체다 — 두 목록을 **함께** 보낸다. 한쪽만 보내면
  // 다른 쪽이 지워진다.
  _aclCollect(){
    return {
      enabled:document.getElementById('acl-enabled').checked,
      entries:this._aclRowsIn('#acl-list'),
      hosts:this._aclRowsIn('#acl-host-list'),
    };
  },

  _aclV4(s){
    const p=String(s).split('.');
    if(p.length!==4) return null;
    let n=0;
    for(const x of p){
      const v=Number(x);
      if(!Number.isInteger(v)||v<0||v>255||x==='') return null;
      n=n*256+v;
    }
    return n>>>0;
  },

  _aclCidrHas(cidr,ip){
    const i=cidr.indexOf('/');
    if(i<0) return false;
    const bits=Number(cidr.slice(i+1));
    const a=this._aclV4(cidr.slice(0,i)),b=this._aclV4(ip);
    if(a===null||b===null||!Number.isInteger(bits)||bits<0||bits>32) return false;
    if(bits===0) return true;
    const mask=(-1<<(32-bits))>>>0;
    return ((a&mask)>>>0)===((b&mask)>>>0);
  },

  /**
   * 저장하려는 목록이 지금 이 브라우저를 통과시키는가.
   *
   * **모르면 통과로 친다.** 이 판정은 경고를 낼지 말지를 정할 뿐이고, 확신 없이
   * 경고를 띄우면 사용자가 경고를 읽지 않게 된다. 아직 해석되지 않은 새 호스트명·
   * IPv6 대역이 그 "모르는" 경우다.
   */
  _aclCoversYou(cfg,you,known){
    if(!you) return true;
    for(const e of cfg.entries){
      if(!e.enabled) continue;
      if(e.value===you) return true;
      if(e.value.indexOf('/')>=0){
        if(this._aclCidrHas(e.value,you)) return true;
        // 판정할 수 없는 것은 **IPv6 대역**뿐이다. IPv4 대역이라면 상대가
        // IPv6 주소여도 결론은 확실하다 — 포함하지 않는다.
        if(this._aclV4(e.value.slice(0,e.value.indexOf('/')))===null) return true;
        continue;
      }
      const v=(known||[]).find(x=>x.value===e.value);
      if(v&&v.resolved&&v.resolved.indexOf(you)>=0) return true;
      if(!v&&!/^[0-9.]+$/.test(e.value)&&e.value.indexOf(':')<0) return true; // 해석 전인 새 이름
    }
    return false;
  },

  _aclHostRow(e){
    return this._aclRow(e,{placeholder:'macmini-office',plain:true});
  },

  async _loadAccessPanel(){
    const box=document.getElementById('acl-list');
    const hostBox=document.getElementById('acl-host-list');
    const status=document.getElementById('acl-status');
    if(!box) return;
    box.innerHTML='';status.textContent='';status.classList.remove('err');
    if(hostBox) hostBox.innerHTML='';
    try{
      const r=await apiGet('/api/access');
      if(!r.ok){
        status.textContent=r.text.trim()||'허용 목록을 읽지 못했습니다';
        status.classList.add('err');
        return;
      }
      const v=r.data||{};
      this._aclKnown=v.entries||[];
      this._aclYou=v.you||'';
      document.getElementById('acl-enabled').checked=!!v.enabled;
      const you=document.getElementById('acl-you');
      you.textContent=v.you||'(알 수 없음)';
      you.title=(v.self&&v.self.length)?('이 서버의 주소: '+v.self.join(', ')):'';
      for(const e of this._aclKnown) box.appendChild(this._aclRow(e));
      // FR-ACL-35: 서버가 자기를 무엇으로 아는지, 지금 어떤 이름으로 불렸는지.
      // 이 둘을 볼 수 없어서 U-18 의 원인을 아무도 짚지 못했다.
      const hn=document.getElementById('acl-hostname');
      if(hn) hn.textContent=v.hostname||'(알 수 없음)';
      const hnow=document.getElementById('acl-host-now');
      if(hnow) hnow.textContent=v.host||'(알 수 없음)';
      if(hostBox) for(const e of (v.hosts||[])) hostBox.appendChild(this._aclHostRow(e));
    }catch(e){
      status.textContent='허용 목록을 읽지 못했습니다 — '+((e&&e.message)||e);
      status.classList.add('err');
    }
  },

  async _aclSave(cfg){
    const status=document.getElementById('acl-status');
    status.classList.remove('err');status.textContent='저장 중…';
    try{
      const r=await apiPut('/api/access',cfg);
      if(!r.ok){
        // 거부 사유가 그대로 온다 — 어느 줄이 잘못됐는지 모르면 고칠 수 없다.
        status.textContent=r.text.trim()||'저장하지 못했습니다';
        status.classList.add('err');
        return;
      }
      // 재로드가 상태줄을 비우므로 문구는 그 **뒤에** 쓴다. 순서가 바뀌면
      // 저장에 성공해도 화면에는 아무 말도 남지 않는다.
      await this._loadAccessPanel();
      status.textContent='저장했습니다';
    }catch(e){
      status.textContent='저장하지 못했습니다 — '+((e&&e.message)||e);
      status.classList.add('err');
    }
  },

  _initAccessPanel(){
    const add=document.getElementById('acl-add');
    const save=document.getElementById('acl-save');
    if(!add||!save) return;
    add.addEventListener('click',()=>
      document.getElementById('acl-list').appendChild(this._aclRow()));
    const hostAdd=document.getElementById('acl-host-add');
    if(hostAdd) hostAdd.addEventListener('click',()=>
      document.getElementById('acl-host-list').appendChild(this._aclHostRow()));
    save.addEventListener('click',()=>{
      const cfg=this._aclCollect();
      if(!cfg.enabled||this._aclCoversYou(cfg,this._aclYou,this._aclKnown)){
        this._aclSave(cfg);
        return;
      }
      // FR-ACL-24: 확인은 한 걸음이다 (CONFIRM_ONE_STAGE_SRS).
      /**
       * FE-17: **마크업을 문자열로 잇지 않는다.** `_aclYou` 는 서버가 준 값이지만
       * 그 값의 재료는 **이 요청의 출발지·Host** 다 — 즉 바깥이 정한다. 서버가
       * 주었다는 사실은 안전의 근거가 되지 않는다.
       *
       * `check-html.sh` 의 머리가 적은 그대로다 — 마크업이 필요한 자리는 DOM 으로
       * 세운다. 이 자리는 게이트의 규칙(템플릿 리터럴)을 지나지 않아 **문자열
       * 이어붙이기로 남아 있었고**, 그래서 게이트도 함께 넓혔다.
       */
      const body=document.createElement('div');
      const p1=document.createElement('p');
      p1.appendChild(document.createTextNode('이 목록은 지금 접속 중인 주소 '));
      const code=document.createElement('code');
      code.textContent=this._aclYou||'';
      p1.appendChild(code);
      p1.appendChild(document.createTextNode(' 를 허용하지 않습니다.'));
      const p2=document.createElement('p');
      p2.appendChild(document.createTextNode('저장하면 '));
      const b=document.createElement('b');
      b.textContent='이 브라우저의 접속이 끊깁니다.';
      p2.appendChild(b);
      p2.appendChild(document.createTextNode(
        ' 서버가 돌고 있는 컴퓨터에서는 언제나 접속되므로 거기서 되돌릴 수 있습니다.'));
      body.appendChild(p1);
      body.appendChild(p2);
      const m=UIKit.modal({
        title:'이 브라우저가 차단됩니다',
        cls:'acl-confirm',
        width:'min(460px,90vw)',
        body,
        // title 을 주면 그것이 aria-label 이 되어 접근 이름이 라벨을 덮는다.
        // 라벨만 둔다 (open-url.js 와 같은 규약).
        actions:[
          {label:'취소'},
          {label:'그래도 저장',kind:'danger',onClick:()=>this._aclSave(cfg)},
        ],
      });
      document.body.appendChild(m.el);
    });
  },
});
