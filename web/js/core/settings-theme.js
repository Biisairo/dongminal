/**
 * ThemeSection — Settings ▸ Theme (REFACTOR3_FE_SETTINGS_SRS 8d, 옛 `app-settings-theme.js`).
 *
 * 테마 목록 · 미리보기 · 사용자 정의 편집기 · 색 입력. 테마가 자기 파일을 갖는
 * 이유는 44개 테마의 목록과 **그것을 고치는 편집기**가 함께 있어야 하기 때문이다.
 *
 * 어느 테마를 적용할지 정하는 `_applyThemeChoice` 는 App 에 남는다(위임자, 본체는 `settings-apply.js`) — 부팅의
 * `_settingsApply` 가 설정창이 서기 전에 부른다. `main.js`·e2e 가 부르는 이름(`_showCustomEditor`·
 * `_hideCustomEditor`·`themeSlots`·`setThemeSlots`)은 App 의 위임자가 이 섹션에 잇는다(FR-FES-9).
 */
/**
 * REFACTOR3_FE_REST3_SRS FR-FR3-11 (FC-12): 미리보기가 읽는 색 변수. 이름은 리터럴이다 — `check-css-vars.mjs` 가
 * 세워지는 이름을 리터럴로 센다(D-FR3-11). `u` 는 대비 파생을 얹은 UI 팔레트, `c` 는 터미널 팔레트, `ah` 는 강조 바탕이다.
 */
function themePreviewVars(u,c,ah){
  return {
    '--pv-bg':u.bg, '--pv-sidebar-bg':u.sidebarBg, '--pv-border':u.border, '--pv-accent':u.accent, '--pv-accent-hl':ah,
    '--pv-accent-border':u.accentBorder, '--pv-text':u.text, '--pv-text-bright':u.textBright, '--pv-text-muted':u.textMuted,
    '--pv-text-dim':u.textDim, '--pv-danger':u.danger,
    '--pv-t-bg':c.background, '--pv-t-fg':c.foreground, '--pv-t-sel-bg':c.selectionBackground,
    '--pv-t-sel-fg':c.selectionForeground, '--pv-t-cursor':c.cursor, '--pv-t-cursor-accent':c.cursorAccent,
    '--pv-t-black':c.black, '--pv-t-red':c.red, '--pv-t-green':c.green, '--pv-t-yellow':c.yellow, '--pv-t-blue':c.blue,
    '--pv-t-magenta':c.magenta, '--pv-t-cyan':c.cyan, '--pv-t-white':c.white, '--pv-t-bright-black':c.brightBlack,
    '--pv-t-bright-red':c.brightRed, '--pv-t-bright-green':c.brightGreen, '--pv-t-bright-yellow':c.brightYellow,
    '--pv-t-bright-blue':c.brightBlue, '--pv-t-bright-magenta':c.brightMagenta, '--pv-t-bright-cyan':c.brightCyan,
    '--pv-t-bright-white':c.brightWhite,
  };
}

/** 견본 한 줄 — 칠 하나에 색 이름을 `title` 로 단다. 이름은 팔레트 키(상수)다. */
function themePreviewSwatches(...names){
  return names.map(n=>'<span class="pv-sw pv-sw-'+n.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())+'" title="'+n+'"></span>').join(' ');
}

/**
 * 미리보기의 골격 — 앱을 줄인 그림 (FR-FR3-10). 싣는 때 한 번 만드는 고정 문자열이고 팔레트 값이 들어가지 않는다.
 * 색은 `themePreviewVars` 가 세운 변수를 `.pv-*` 규칙이 읽는다(`style-modal.css`). ANSI 16색은 **글자가 아니라 칠**로
 * 보인다. 종전의 `● Bk`(검정 위의 검정, 1.05:1)는 읽으라는 글이 아니었는데 글자로 서 있었다 — 색 표본은 견본이다.
 */
const THEME_PREVIEW_HTML=`
    <div class="pv-root">
      <div class="pv-sidebar">
        <div class="pv-sb-head">SESSIONS</div>
        <div class="pv-sb-row">
          <div class="pv-dot"></div>
          <span class="pv-sb-name">Main</span>
          <span class="pv-sb-x">×</span>
        </div>
        <div class="pv-sb-row pv-on">
          <div class="pv-dot"></div>
          <span class="pv-sb-name pv-b">Work</span>
          <span class="pv-sb-x">×</span>
        </div>
        <div class="pv-sb-row">
          <div class="pv-dot pv-dim"></div>
          <span class="pv-sb-name pv-plain">Test</span>
          <span class="pv-sb-x pv-faint">×</span>
        </div>
      </div>
      <div class="pv-main">
        <div class="pv-topbar">
          <span class="pv-c-text">Work</span>
          <span class="pv-grow"></span>
          <span class="pv-btn">Split H</span>
          <span class="pv-btn pv-btn-on">Split V</span>
        </div>
        <div class="pv-split">
          <div class="pv-split-left">
            <div class="pv-tabs">
              <div class="pv-tab pv-tab-r">Shell <span class="pv-x">×</span></div>
              <div class="pv-tab pv-tab-on">vim <span class="pv-x">×</span></div>
            </div>
            <div class="pv-term">
              <span class="pv-t-green">$</span> <span class="pv-t-cyan">echo</span> <span class="pv-t-yellow">"palette"</span><br>
              <span class="pv-sel">selected text here █</span><br>
              ${themePreviewSwatches('red','green','yellow','blue')}<br>
              ${themePreviewSwatches('magenta','cyan','white','brightBlack')}<br>
              ${themePreviewSwatches('brightRed','brightGreen','brightYellow','brightBlue')}<br>
              ${themePreviewSwatches('brightMagenta','brightCyan','brightWhite','black')}
            </div>
          </div>
          <div class="pv-gutter"></div>
          <div class="pv-split-right">
            <div class="pv-tabs">
              <div class="pv-tab pv-tab-on">htop <span class="pv-x">×</span></div>
              <div class="pv-tab pv-tab-l">Shell <span class="pv-x">×</span></div>
            </div>
            <div class="pv-term">
              <span class="pv-t-cyan">PID</span> <span class="pv-t-green">CPU</span> <span class="pv-t-yellow">MEM</span> <span class="pv-t-blue">CMD</span><br>
              <span class="pv-t-fg"> 1  </span><span class="pv-t-green">  2% </span><span
                class="pv-t-yellow">  1% </span><span class="pv-t-fg">bash</span><br>
              <span class="pv-t-fg"> 42 </span><span class="pv-t-red"> 99% </span><span class="pv-t-red"> 45% </span><span class="pv-t-fg">node</span><br>
              <br>
              <span class="pv-t-fg">cursor: </span><span class="pv-cur"> █ </span>
            </div>
          </div>
        </div>
        <div class="pv-status">
          <span class="pv-c-accent">●</span>
          <span class="pv-st-info">2 windows · 3 panes</span>
          <span class="pv-st-err">ERR</span>
          <span class="pv-st-ok">OK</span>
        </div>
      </div>
    </div>`;

class ThemeSection extends SettingsSection {
  constructor(app){ super(app,'theme') }

  /** SYSTEM_THEME_FOLLOW_SRS FR-STF-2: 시스템 모드가 바뀌면 그 자리에서 다시 고른다 — 새로고침이 없다. */
  init(){
    if(typeof matchMedia!=='function') return;
    const mq=matchMedia('(prefers-color-scheme: dark)');
    const on=()=>{if(themeFollowSystem){this.app._applyThemeChoice();this._renderThemePanel()}};
    if(mq.addEventListener) this.listen(mq,'change',on); else if(mq.addListener) mq.addListener(on);
  }

  /** 설정을 열 때 — 목록·메인색 행·미리보기를 지금 값으로 다시 그린다. */
  onOpen(){ this._renderThemePanel() }

  /** e2e 계약 — 슬롯을 읽고 세운다 (APP_TESTING_CONTRACT). */
  themeSlots(){return {dark:themeNameDark,light:themeNameLight}}
  setThemeSlots(s){
    if(s&&THEMES[s.dark]) themeNameDark=s.dark;
    if(s&&THEMES[s.light]) themeNameLight=s.light;
    this.app._applyThemeChoice(); this._renderThemePanel(); this.app.saveSettings();
  }

  /**
   * THEME_SEED_COLOR_SRS FR-SEED-12: 메인색 행 — 스위치·색 입력·견본 8개. 견본은 색상 0°·45°·…를
   * **지금 테마에 맞춘** 색(원래 accent 의 밝기·채도, D-SEED-2)으로 칠한다. 단추는 한 번 만든다.
   */
  _renderSeedRow(){
    const row=document.getElementById('theme-seed-row'); if(!row) return;
    const sw=row.querySelector('#ds-theme-seed'), inp=row.querySelector('.seed-color'), box=row.querySelector('.seed-swatches');
    const on=!!seedColor, a0=oklchOf(getCurrentTheme().ui.accent);
    sw.checked=on; inp.disabled=!on;
    inp.value=seedColor||getCurrentTheme().ui.accent;
    if(!box.children.length){
      for(let h=0;h<360;h+=SEED_SWATCH_STEP){
        const b=document.createElement('button');
        b.type='button'; b.className='ui-btn ui-btn-icon seed-swatch'; b.dataset.hue=String(h);
        b.setAttribute('aria-label',TIP_THEME_HUE+h+'°'); b.title=TIP_THEME_HUE+h+'°';
        b.addEventListener('click',()=>{const o=oklchOf(getCurrentTheme().ui.accent);seedColor=hexOfOklch(o.L,o.C,h);this._seedChanged(true)});
        box.appendChild(b);
      }
      this.listen(sw,'change',()=>{
        seedColor=sw.checked?(PrefStore.local.get(SEED_LAST_KEY)||getCurrentTheme().ui.accent):'';
        this._seedChanged(true);
      });
      // 끄는 동안은 화면만 따라가고 놓을 때 저장한다 (FR-SEED-10, 편집기 FEC-5 와 같다).
      this.listen(inp,'input',()=>{seedColor=inp.value.toLowerCase();this._seedChanged(false)});
      this.listen(inp,'change',()=>this.app._saveSettingsNow('seed-color'));
    }
    for(const b of box.children){
      b.disabled=!on;
      b.style.background=hexOfOklch(a0.L,a0.C,Number(b.dataset.hue));
    }
  }

  /** FR-SEED-10·11: 메인색이 바뀌었다 — 다시 적용하고, 패널·편집기 안내를 고친다. */
  _seedChanged(save){
    if(seedColor) PrefStore.local.set(SEED_LAST_KEY,seedColor);
    this.app._applyThemeChoice(); this._renderThemePanel(); this._paintSeedHint();
    if(save) this.app.saveSettings(); else this.app._saveSettingsSoon('seed-color');
  }

  /** FR-SEED-11: 편집기는 원본을 고친다 — 메인색이 켜져 있으면 그 사실을 알린다. */
  _paintSeedHint(){
    const hint=document.querySelector('#custom-editor .seed-hint');
    if(hint) hint.hidden=!seedColor;
  }

  _renderThemePanel(){
    this._renderSeedRow();
    const list=document.getElementById('theme-list'); list.innerHTML='';
    // FR-STF-8: 스위치는 목록 위의 `.ds-row` 하나 — 이름은 구조에서 파생한다.
    const head=document.getElementById('theme-follow-row');
    if(head){
      const cb=head.querySelector('#ds-theme-follow');
      cb.checked=themeFollowSystem;
      if(!cb._bound){
        cb._bound=true;
        this.listen(cb,'change',()=>{
          themeFollowSystem=cb.checked;
          // FR-STF-4: 켜는 순간 지금 테마가 자기 모드의 슬롯에 들어간다.
          if(themeFollowSystem&&!customTheme){
            const theme=THEMES[currentThemeName];
            if(theme&&theme.mode==='light') themeNameLight=currentThemeName; else if(theme) themeNameDark=currentThemeName;
          }
          this.app._applyThemeChoice(); this._renderThemePanel(); this.app.saveSettings();
        });
      }
      // FR-STF-7: 사용자 정의가 있는데 추종이 켜져 있으면 그것은 적용되지 않는다.
      const hint=head.nextElementSibling;
      if(hint&&hint.classList.contains('ds-hint')) hint.hidden=!(themeFollowSystem&&customTheme);
    }
    const activeName=customTheme&&!themeFollowSystem?null:currentThemeName;
    // FR-STF-3: 반대 모드의 슬롯도 보인다 — 적용 중이 아니어도 고른 것이다.
    const slotName=themeFollowSystem?(systemColorMode()==='dark'?themeNameLight:themeNameDark):null;
    // `G7-1` 첫 판: 스크롤 영역에 키보드가 닿아야 한다(axe `scrollable-region-
    // focusable`) — 그리고 테마를 **고르는** 일도 키보드로 되어야 한다 (2.1.1).
    // 목록은 listbox, 항목은 option, 키 계약은 `UIKit.roving` 한 벌이다 (D-A11Y-11).
    list.setAttribute('role','listbox');
    list.setAttribute('aria-label',TIP_THEME_LIST);
    if(!list._kbNav){
      list._kbNav=true;
      UIKit.roving(list,{
        items:()=>[...list.querySelectorAll('.tl-item')],
        activate:el=>el.click(),
      });
    }
    const groups={dark:[],light:[]};
    for(const name of Object.keys(THEMES)){
      const theme=THEMES[name];
      (theme.mode==='light'?groups.light:groups.dark).push(name);
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
        const theme=THEMES[name];
        const item=document.createElement('div');
        item.className='tl-item'+(name===activeName?' active':'')+(name===slotName?' slot':'');
        item.setAttribute('role','option');
        item.setAttribute('aria-selected',name===activeName?'true':'false');
        item.tabIndex=-1;
        // 색 점과 이름을 **DOM 으로 세운다.** 종전에는 마크업 문자열을 이어
        // 붙였고, `t.ui[k]` 와 `name` 은 사용자가 만든 테마에서 온다 — 문자열
        // 조립은 그 값들이 마크업이 되는 길이었다.
        const keys=['bg','accent','text','border','danger'];
        const dots=document.createElement('div');
        dots.className='tl-dots';
        // FR-SEED-13: 점은 메인색 변환 결과다 — 고르기 전에 결과를 본다.
        const shown=seedTheme(theme,seedColor);
        for(const k of keys){
          const dot=document.createElement('span');
          dot.style.background=shown.ui[k];
          dots.appendChild(dot);
        }
        const label=document.createElement('span');
        label.className='tl-name';
        label.textContent=name;
        item.appendChild(dots); item.appendChild(label);
        item.addEventListener('click',()=>{
          // FR-STF-3: 추종 중에는 그 테마의 모드에 맞는 슬롯이 바뀐다 — 지금
          // 시스템 모드와 같은 쪽이면 즉시 적용되고, 아니면 저장만 된다.
          if(themeFollowSystem){
            if(theme.mode==='light') themeNameLight=name; else themeNameDark=name;
            this.app._applyThemeChoice(); this._renderThemePanel(); this.app.saveSettings();
            return;
          }
          currentThemeName=name; customTheme=null;
          applyThemeObj(theme); this._renderThemePanel(); this._hideCustomEditor();
          this.app.saveSettings();
        });
        grp.appendChild(item);
      }
    };
    renderGroup('Dark', groups.dark);
    renderGroup('Light', groups.light);
    const items=[...list.querySelectorAll('.tl-item')];
    UIKit.rove(items,items.find(i=>i.classList.contains('active')));
    this._renderPreview();
  }

  _renderPreview(){
    const theme=getAppliedTheme();   // THEME_SEED_COLOR_SRS FR-SEED-9a
    const tr=theme.terminal;
    /**
     * `G7-1` 첫 판: 미리보기의 글자는 **화면이 실제로 쓸 값**이어야 한다.
     * 종전에는 팔레트의 원시값(`ui.textMuted`)으로 그렸고, 그것은 파생(FR-TOK-13)
     * 이 바닥을 끌어올리기 **전**의 색이다 — 그래서 미리보기는 실제 화면보다
     * 흐렸고 axe 가 그 흐림을 잡았다(2.9:1). 파생을 같은 함수로 얹어 미리보기가
     * 곧 화면이 되게 한다 (D-TOK-5 의 "같은 함수" 규약).
     */
    const aa=deriveContrastTokens(theme.ui,theme.mode,pickAttnColor(theme),tr);
    const u=Object.assign({},theme.ui,{text:aa.text,textBright:aa.textBright,textMuted:aa.textMuted});
    // `G7-1` 첫 판: 미리보기는 테마의 **그림**이다 — 6~9px 의 팔레트 리터럴 글자는
    // 읽으라고 있는 글이 아니라 색의 표본이다. 이미지로 선언하면 안의 글자가
    // 접근성 트리에서 표현용이 되고, axe 의 대비 규칙도 그림 안을 읽지 않는다.
    const pv=document.getElementById('theme-preview');
    pv.setAttribute('role','img');
    pv.setAttribute('aria-label',TIP_THEME_PREVIEW+(customTheme?'Custom':currentThemeName));
    // REFACTOR3_FE_REST3_SRS FR-FR3-10·11 (FC-12): 색은 변수로만 들어간다 — 마크업에는 값이 들어갈 자리가 없다.
    const vars=themePreviewVars(u,tr,hexToRgba(u.accent,.08));
    for(const [k,v] of Object.entries(vars)) pv.style.setProperty(k,v);
    pv.innerHTML=THEME_PREVIEW_HTML;
  }

  _hideCustomEditor(){
    document.getElementById('custom-editor').hidden=true;
    document.getElementById('custom-toggle').classList.remove('active');
  }

  _showCustomEditor(){
    const base=getCurrentTheme();
    customTheme=JSON.parse(JSON.stringify(base));
    // UX_AUDIT_FIX_SRS FR-UXF-127: 이 슬롯 전에 저장한 테마는 accent2 가 없다 — 입력이 지금 쓰는 파생값을 보인다.
    if(!customTheme.ui.accent2) customTheme.ui.accent2=pickAccent2(customTheme);
    document.getElementById('custom-toggle').classList.add('active');
    document.getElementById('custom-editor').hidden=false;
    this._paintSeedHint();
    // UI colors
    const uiDiv=document.getElementById('ce-ui'); uiDiv.innerHTML='';
    for(const [key,label] of Object.entries(UI_LABELS)){
      uiDiv.appendChild(this._colorInput(key,label,'ui'));
    }
    // Terminal colors
    const termDiv=document.getElementById('ce-terminal'); termDiv.innerHTML='';
    for(const [key,label] of Object.entries(TERM_LABELS)){
      termDiv.appendChild(this._colorInput(key,label,'terminal'));
    }
  }

  /**
   * 색 입력 하나. `section` 은 `customTheme` 의 칸 이름이다 (`ui`·`terminal`).
   *
   * OPTIMIZE_REFACTOR_SRS FR-OPT-5-2 (FEC-4): **객체를 묶지 않고 칸 이름을 묶는다.**
   * 종전에는 `customTheme.ui` 참조를 쥐었고, 설정 방송이 `customTheme` 을 새 객체로
   * 갈아 끼운 뒤로는 입력이 옛 객체를 고쳐 화면에도 저장에도 닿지 않았다. 입력
   * 순간의 전역을 고친다.
   *
   * 끄는 동안(`input`)은 화면만 따라가고 저장은 미룬다 (FEC-5). 놓을 때(`change`)
   * 확정한다.
   */
  _colorInput(key,label,section){
    const item=document.createElement('div'); item.className='ce-item';
    const lbl=document.createElement('label'); lbl.textContent=label;
    const inp=document.createElement('input'); inp.type='color';
    inp.value=(customTheme&&customTheme[section]&&customTheme[section][key])||'#000000';
    inp.addEventListener('input',()=>{
      if(!customTheme||!customTheme[section]) return;
      customTheme[section][key]=inp.value;
      applyThemeObj(customTheme);
      this._renderPreview();
      this.app._saveSettingsSoon('theme-color');
    });
    inp.addEventListener('change',()=>{
      if(customTheme) this.app._saveSettingsNow('theme-color');
    });
    item.appendChild(lbl); item.appendChild(inp);
    return item;
  }
}
