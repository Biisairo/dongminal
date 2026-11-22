/**
 * TerminalSection — Settings ▸ Terminal (REFACTOR3_FE_SETTINGS_SRS 8a). 모바일 키바 구성(`#ds-keybar`)은 8d 에서 왔다
 * (옛 `app-settings-keybar.js`) — 변경은 곧바로 키바에 얹히고 저장된다. 모바일 키바에 얹는 `_keybarApply` 는 `settings.apply` 의 것이다(본체는
 * `SettingsApply`): 설정 `keybar` 의 setter 가 설정창이 서기 전(부팅)에도 부른다. 구성 목록은 이 섹션의 `paint` 가 칠한다(QUALITY_FIX_SRS FR-QFX-10).
 *
 * `Claude Code 를 fullscreen 으로`(AGENT_RENDER_ENV_SRS FR-ARE-3)와 스크롤 속도(FR-ARE-10·11)는 **쓰는 주체가
 * 서버**다 — 도구를 띄울 때 환경에 넣는다. 화면은 값을 들고 저장할 뿐이고, 이미 떠 있는 터미널은 바뀌지 않는다.
 * migration 넷(ISSUE_TREE_OPS_SRS FR-ITM-1·2)도 서버가 훅 판정과 트리 프리앰블에 쓴다. 일반 훅과 issue-tree 는 따로다.
 */
const KEYBAR_MACRO_ID_PREFIX='m';

class TerminalSection extends SettingsSection {
  constructor(app){ super(app,'terminal') }

  init(){
    // REFACTOR3_FE_FIX_SRS FR-FFX-7: 숫자 행은 포커스 가드를 갖는다 — 다른 창의 방송이 치는 중인 글자를 덮었다(실측).
    this.bindRows([
      {key:'claudeFullscreen',id:'ds-claudefs',kind:'check'},
      // FONT_SIZE_SETTING_SRS FR-FSS-11·12: 터미널만 움직인다.
      {key:'termFontSize',id:'ds-termfs',kind:'number',guard:true},
      {key:'claudeScrollSpeed',id:'ds-scrollspeed',kind:'number',guard:true},
      {key:'migrationHook',id:'ds-mighook',kind:'check'},
      {key:'migrationHookCtxPct',id:'ds-mighookpct',kind:'number',guard:true},
      {key:'issueTreeMigration',id:'ds-treemig',kind:'check'},
      {key:'issueTreeCtxPct',id:'ds-treemigpct',kind:'number',guard:true},
    ]);
    this.paint();
    this._initTermGpu();
    this._initKeybar();
  }

  /**
   * 행과 키바 구성 목록 (QUALITY_FIX_SRS FR-QFX-10). 계기는 다른 섹션과 같다 — 부팅(`init`) · 값을 얹은 뒤 · 설정을 열 때.
   *   이전: 목록은 `_keybarApply` 가 섹션이 있을 때만 칠했다(값을 얹을 때만, 열 때는 칠하지 않았다)
   */
  paint(){
    super.paint();
    this._keybarPaint();
  }

  /** TERMINAL_GPU_RENDER_SRS FR-TGR-14·15: 기기별 값이다 — 서버 설정 블롭에 싣지 않는다. */
  _initTermGpu(){
    const cb=document.getElementById('ds-termgpu');
    if(!cb) return;
    cb.checked=TermGpu.enabled();
    this.listen(cb,'change',()=>TermGpu.setEnabled(cb.checked,this.app));
  }

  /** UX_AUDIT_FIX_SRS FR-UXF-95 (D-31): 모바일 키바 구성. 순서 규칙과 바이트는 `keybar.js` 의 것이고, 여기는 행을 그리고 손짓을 구성 값으로 옮긴다. */
  _initKeybar(){
    const sec=document.getElementById('ds-keybar');
    if(!sec) return;
    const add=sec.querySelector('.kbc-add');
    const lbl=add.querySelector('.kbc-lbl');
    const btn=add.querySelector('.kbc-add-btn');
    add.querySelector('.kbc-key').replaceChildren(...KEYBAR_MACRO_KEYS.map(k=>{
      const o=document.createElement('option');
      o.value=k;o.textContent=MKB_COMBO_KEY_LABEL[k]||k.toUpperCase();
      return o;
    }));
    // 수식이 하나도 없으면 `추가` 는 비활성이다. 라벨 칸의 자리표시가 기본 라벨을 미리 보인다.
    const sync=()=>{
      const m=this._keybarDraft();
      btn.disabled=!mkbMacroValid(m);
      lbl.placeholder=mkbComboLabel(m);
    };
    this.listen(add,'change',sync);
    this.listen(btn,'click',()=>{
      const m=this._keybarDraft();
      if(!mkbMacroValid(m)) return;
      const l=lbl.value.trim();
      if(l) m.label=l;
      m.id=KEYBAR_MACRO_ID_PREFIX+Date.now().toString(36);
      lbl.value='';
      this._keybarSet(keybarAddMacro(keybarCfg,m));
    });
    this.listen(sec.querySelector('.kbc-reset'),'click',()=>this._keybarSet(keybarReset(keybarCfg)));
    const list=sec.querySelector('.kbc-list');
    this.listen(list,'change',e=>{
      const row=e.target.closest('.kbc-row');
      if(row&&e.target.classList.contains('kbc-on')) this._keybarSet(keybarToggle(keybarCfg,row.dataset.id,e.target.checked));
    });
    this.listen(list,'click',e=>{
      const b=e.target.closest('button[data-act]');
      const row=b&&b.closest('.kbc-row');
      if(!row) return;
      const id=row.dataset.id;
      if(b.dataset.act==='del') this._keybarSet(keybarRemoveMacro(keybarCfg,id));
      else this._keybarSet(keybarMove(keybarCfg,id,b.dataset.act==='up'?-1:1));
    });
    sync();
  }

  /** 추가 줄이 지금 가리키는 조합. */
  _keybarDraft(){
    const add=document.querySelector('#ds-keybar .kbc-add');
    const on=c=>add.querySelector(c).checked;
    return {key:add.querySelector('.kbc-key').value,ctrl:on('.kbc-ctrl'),alt:on('.kbc-alt'),shift:on('.kbc-shift')};
  }

  _keybarSet(cfg){
    keybarCfg=cfg;
    this.app.settings.apply._keybarApply();
    this._keybarPaint();
    this.app.settings.apply.saveSettings();
  }

  /** FR-UXF-95: 행마다 라벨·이름·켜기·위·아래, 매크로는 지우기. `⌨` 는 행이 없다. */
  _keybarPaint(){
    const list=document.querySelector('#ds-keybar .kbc-list');
    if(!list) return;
    const rows=keybarRows(keybarCfg);
    list.innerHTML='';
    rows.forEach(({key:k,on},i)=>{
      const row=document.createElement('div');
      row.className='kbc-row'+(k.macro?' kbc-macro':'');
      row.dataset.id=k.id;
      const lab=document.createElement('span');
      lab.className='kbc-label mono';lab.textContent=k.label;
      const name=document.createElement('span');
      name.className='kbc-name';name.lang='en';name.textContent=k.name||MKB_FULL_NAMES[k.label]||k.label;
      const sw=document.createElement('input');
      sw.type='checkbox';sw.className='ui-switch kbc-on';sw.checked=on;sw.setAttribute('aria-label',name.textContent);
      const btn=(act,icon,title,disabled)=>UIKit.button({icon,title,kind:'ghost',size:'sm',cls:'kbc-'+act,dataset:{act},disabled});
      row.append(lab,name,sw,btn('up','arrow-up',TIP_KEYBAR_UP,i===0),btn('down','arrow-down',TIP_KEYBAR_DOWN,i===rows.length-1));
      if(k.macro) row.appendChild(btn('del','trash',TIP_KEYBAR_DEL,false));
      list.appendChild(row);
    });
  }
}
