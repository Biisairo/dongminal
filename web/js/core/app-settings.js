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
    try{await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({themeName:customTheme?null:currentThemeName,customTheme,shortcuts,statusBar,statsInterval,gitSignatureInterval,gitStatusInterval,layoutPresets,defaultPreset,fgTabNames,blockBrowserKeys,pageTitle,confirmLeave})})}catch{}
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
      // FR-WSL-81: 슬롯 방향 세그먼트. 열 때마다 현재 값을 다시 칠한다.
      this._slotDirPaint();
      const scBlock=document.getElementById('sc-blockbrowser');
      if(scBlock) scBlock.checked=blockBrowserKeys;
      // FR-LVC-3: 열 때마다 현재 값을 다시 칠한다 — 다른 화면에서 바뀐 값이
      // 이 모달에 옛 상태로 남아 있으면 사용자가 그것을 켜진 줄로 읽는다.
      const dsLeave=document.getElementById('ds-confirmleave');
      if(dsLeave) dsLeave.checked=confirmLeave;
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
        // 샌드박스 정의는 파일이 진실이다. 열 때마다 다시 읽어야 바깥에서
        // 고친 것과 어긋나지 않는다.
        if(tab.dataset.tab==='sandbox')this._loadSandboxPanel();
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
    this._initFgNames();
    this._initBlockKeys();
    this._initConfirmLeave();
    this._initLSP();
    this._initBackup();
    this._initSandboxPanel();
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
      // FR-WSL-51: 창 **안**의 분할과 창 **밖**의 슬롯은 다른 것이다 (§7 R-3).
      // 같은 그룹에 두되 라벨이 그 차이를 말한다.
      {label:'분할',keys:['splitH','splitV','slotAdd','slotRemove']},
      // PANEL_SHORTCUTS_SRS FR-PSC-5: 상단 툴바의 진입점 셋. 목록의 차례를
      // 툴바의 차례(Runs · Background · Agents)와 맞춘다.
      {label:'패널',keys:['runsToggle','bgToggle','agentsToggle']},
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
    // FR-LVC-6: 저장된 적 없으면 기본값(끔). 다른 값들과 같이 각자 판단한다.
    if(saved.confirmLeave!==undefined){
      confirmLeave=!!saved.confirmLeave;
      const cl=document.getElementById('ds-confirmleave');
      if(cl) cl.checked=confirmLeave;
    }
    if(saved.fgTabNames===undefined) return;
    fgTabNames=!!saved.fgTabNames;
    if(window.app&&app._fgRepaint) app._fgRepaint();
    const cb=document.getElementById('ds-fgnames');
    if(cb) cb.checked=fgTabNames;
  }catch{}
})();

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
    const del=document.createElement('button');
    del.type='button';del.className='sbx-del';del.textContent='×';del.title='이 마운트를 지웁니다';
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
      const r=await fetch('/api/sandbox/config');
      if(!r.ok){
        // 런타임이 없으면 설정할 대상 자체가 없다. 빈 화면보다 이유가 낫다.
        status.textContent=(await r.text()).trim()||'샌드박스 설정을 읽지 못했습니다';
        status.classList.add('err');
        return;
      }
      const cfg=await r.json();
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
        const r=await fetch('/api/sandbox/config',{method:'PUT',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(this._sbxCollect())});
        if(!r.ok){
          // 거부 사유가 그대로 온다 — 무엇이 잘못됐는지 모르면 고칠 수 없다.
          status.textContent=(await r.text()).trim()||'저장하지 못했습니다';
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
});
