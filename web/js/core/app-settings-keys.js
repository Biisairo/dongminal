/**
 * Dongminal — 설정창의 **단축키 패널** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 목록을 그리고, 한 줄을 눌러 새 조합을 **녹화**한다. 녹화 중에는 그 키가
 * 화면의 다른 곳으로 새지 않아야 하므로 취소 경로가 짝으로 있다.
 */
Object.assign(App.prototype, {
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
      // `DOC-3` (M5): 이 넷은 기본값이 있는데 **어느 그룹에도 없었다.** 그래서
      // Settings ▸ Shortcuts 에 뜨지 않았고, 뜨지 않으면 바꿀 수 없다 —
      // `shortcuts.md` 첫 줄의 "모든 앱 단축키는 커스터마이징 가능합니다" 가
      // 그 순간 거짓이 된다. `scripts/check-shortcuts-docs.sh` 가 재발을 막는다.
      {label:'Editor 코드 탐색',keys:['edGotoDef','edFindRefs','edNavBack']},
      {label:'Editor 편집',keys:['edSave','edSaveAll']},
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
          this.recording=k;btn.textContent='키를 누르세요...';btn.classList.add('recording');
        });
        const rst=UIKit.button({icon:'undo',title:SHORTCUT_RESET_TITLE,kind:'ghost',size:'sm',cls:'sc-rst'});
        rst.addEventListener('click',()=>{shortcuts[k]=SHORTCUT_DEFAULTS[k];this.saveSettings();btn.textContent=displayKey(shortcuts[k])});
        row.appendChild(label);
        const btns=document.createElement('div');btns.className='sc-btns';
        btns.appendChild(btn);btns.appendChild(rst);
        row.appendChild(btns);
        el.appendChild(row);
      }
    }
  },

  _cancelRecording(){
    if(!this.recording)return;
    const btn=document.querySelector('.sc-key.recording');
    if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
    this.recording=null;
  },
});
