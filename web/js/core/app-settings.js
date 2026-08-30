/**
 * Remote Terminal — App 설정 모달·테마 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 9개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  async _saveSettings(){
    // 블롭 전체를 갈아치우므로 읽어 쓰는 값은 전부 실어야 한다 — git 주기(FR-GIT-23)는
    // UI 가 없지만 여기서 빠지면 다른 설정을 건드릴 때 조용히 사라진다.
    try{await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({themeName:customTheme?null:currentThemeName,customTheme,shortcuts,statusBar,statsInterval,gitSignatureInterval,gitStatusInterval,layoutPresets,defaultPreset,fgTabNames,blockBrowserKeys,pageTitle})})}catch{}
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
      clearTimeout(this._titleSaveTimer);
      this._titleSaveTimer=setTimeout(()=>this._saveSettings(),500);
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

  // ── Modal & Theme ──

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
      const scBlock=document.getElementById('sc-blockbrowser');
      if(scBlock) scBlock.checked=blockBrowserKeys;
      // Auto-close drawer when opening settings on mobile
      if(this.isMobile && this._drawerOpen){this._toggleDrawer(false);this._rTopbar()}
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
      });
    });
    this._initPageTitle();
    this._initFgNames();
    this._initBlockKeys();
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
        const keys=['bg','accent','text','border','danger'];
        let dots='<div class="tl-dots">';
        for(const k of keys){const v=t.ui[k];dots+=`<span style="background:${v}"></span>`}
        dots+='</div>';
        item.innerHTML=`${dots}<span class="tl-name">${name}</span>`;
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
      {label:'분할',keys:['splitH','splitV']},
      {label:'에이전트',keys:['agentsToggle']},
      {label:'새로고침',keys:['softReload']},
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
        // Click → record mode
        btn.addEventListener('click',()=>{
          this._cancelRecording();
          this._recording=k;btn.textContent='키를 누르세요...';btn.classList.add('recording');
        });
        const rst=document.createElement('button');rst.className='sc-rst';rst.textContent='↺';rst.title='초기화';
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

// FR-TAN-19 의 값을 서버에서 읽어 온다. main.js 의 설정 로더가 키를 하나씩
// 나열하는 구조라 이 값만 따로 받는다 — 로더에 한 줄 붙이는 편이 요청이 하나
// 줄지만, 그 파일은 이 작업의 소유가 아니다.
(async()=>{
  try{
    const r=await fetch('/api/settings');
    if(!r.ok) return;
    const saved=await r.json();
    // FR-KEY-6: 저장된 적 없으면 기본값(켬). 두 값이 각자 그렇게 판단한다.
    if(saved.blockBrowserKeys!==undefined){
      blockBrowserKeys=!!saved.blockBrowserKeys;
      const bk=document.getElementById('sc-blockbrowser');
      if(bk) bk.checked=blockBrowserKeys;
    }
    if(saved.fgTabNames===undefined) return;
    fgTabNames=!!saved.fgTabNames;
    if(window.app&&app._fgRepaint) app._fgRepaint();
    const cb=document.getElementById('ds-fgnames');
    if(cb) cb.checked=fgTabNames;
  }catch{}
})();
