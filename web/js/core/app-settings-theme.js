/**
 * Dongminal — 설정창의 **테마 패널** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 테마 목록 · 미리보기 · 사용자 정의 편집기 · 색 입력. 테마가 자기 파일을 갖는
 * 이유는 44개 테마의 목록과 **그것을 고치는 편집기**가 함께 있어야 하기 때문이다.
 */
Object.assign(App.prototype, {
  _renderThemePanel(){
    const list=document.getElementById('theme-list'); list.innerHTML='';
    const activeName=customTheme?null:currentThemeName;
    // `G7-1` 첫 판: 스크롤 영역에 키보드가 닿아야 한다(axe `scrollable-region-
    // focusable`) — 그리고 테마를 **고르는** 일도 키보드로 되어야 한다 (2.1.1).
    // 목록은 listbox, 항목은 option, 키 계약은 `UIKit.roving` 한 벌이다 (D-A11Y-11).
    list.setAttribute('role','listbox');
    list.setAttribute('aria-label','Theme');
    if(!list._kbNav){
      list._kbNav=true;
      UIKit.roving(list,{
        items:()=>[...list.querySelectorAll('.tl-item')],
        activate:el=>el.click(),
      });
    }
    const groups={dark:[],light:[]};
    for(const name of Object.keys(THEMES)){
      const t=THEMES[name];
      (t.mode==='light'?groups.light:groups.dark).push(name);
    }
    const renderGroup=(label,names)=>{
      if(!names.length) return;
      // listbox 의 자식은 option 과 group 뿐이다 — 머리글은 group 의 이름이 된다.
      const grp=document.createElement('div');
      grp.setAttribute('role','group');
      const hdr=document.createElement('div');
      hdr.className='tl-section'; hdr.textContent=label;
      hdr.id='tl-section-'+label.toLowerCase();
      grp.setAttribute('aria-labelledby',hdr.id);
      grp.appendChild(hdr);
      list.appendChild(grp);
      for(const name of names){
        const t=THEMES[name];
        const item=document.createElement('div');
        item.className='tl-item'+(name===activeName?' active':'');
        item.setAttribute('role','option');
        item.setAttribute('aria-selected',name===activeName?'true':'false');
        item.tabIndex=-1;
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
          this.saveSettings();
        });
        grp.appendChild(item);
      }
    };
    renderGroup('Dark', groups.dark);
    renderGroup('Light', groups.light);
    const items=[...list.querySelectorAll('.tl-item')];
    UIKit.rove(items,items.find(i=>i.classList.contains('active')));
    this._renderPreview();
  },

  _renderPreview(){
    const t=getCurrentTheme();
    const tr=t.terminal;
    /**
     * `G7-1` 첫 판: 미리보기의 글자는 **화면이 실제로 쓸 값**이어야 한다.
     * 종전에는 팔레트의 원시값(`ui.textMuted`)으로 그렸고, 그것은 파생(FR-TOK-13)
     * 이 바닥을 끌어올리기 **전**의 색이다 — 그래서 미리보기는 실제 화면보다
     * 흐렸고 axe 가 그 흐림을 잡았다(2.9:1). 파생을 같은 함수로 얹어 미리보기가
     * 곧 화면이 되게 한다 (D-TOK-5 의 "같은 함수" 규약).
     */
    const aa=deriveContrastTokens(t.ui,t.mode,pickAttnColor(t),tr);
    const u=Object.assign({},t.ui,{text:aa.text,textBright:aa.textBright,textMuted:aa.textMuted});
    const ah=hexToRgba(u.accent,.08);
    const c=tr; // shorthand
    // ANSI 16색은 **글자가 아니라 칠**로 보인다. 종전의 `● Bk`(검정 위의 검정,
    // 1.05:1)는 읽으라는 글이 아니었는데 글자로 서 있었다 — 색 표본은 견본이다.
    const sw=(...names)=>names.map(n=>'<span class="pv-sw" style="background:'+c[n]+'" title="'+n+'"></span>').join(' ');
    // `G7-1` 첫 판: 미리보기는 테마의 **그림**이다 — 6~9px 의 팔레트 리터럴 글자는
    // 읽으라고 있는 글이 아니라 색의 표본이다. 이미지로 선언하면 안의 글자가
    // 접근성 트리에서 표현용이 되고, axe 의 대비 규칙도 그림 안을 읽지 않는다.
    const pv=document.getElementById('theme-preview');
    pv.setAttribute('role','img');
    pv.setAttribute('aria-label','Theme preview: '+(customTheme?'Custom':currentThemeName));
    pv.innerHTML=`
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
              ${sw('red','green','yellow','blue')}<br>
              ${sw('magenta','cyan','white','brightBlack')}<br>
              ${sw('brightRed','brightGreen','brightYellow','brightBlue')}<br>
              ${sw('brightMagenta','brightCyan','brightWhite','black')}
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
      this.saveSettings();
    });
    item.appendChild(lbl); item.appendChild(inp);
    return item;
  },
});
