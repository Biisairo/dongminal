/**
 * Remote Terminal — 설정 `터미널` 탭의 `모바일 키바` 구역 (UX_AUDIT_FIX_SRS FR-UXF-95, D-31)
 *
 * 변경은 곧바로 키바에 얹히고 저장된다 — 같은 탭의 스위치와 같은 규약이다. 순서 규칙과 바이트는
 * keybar.js 의 것이고, 여기는 행을 그리고 손짓을 구성 값으로 옮긴다. app.js 뒤에 로드된다.
 */
const KEYBAR_MACRO_ID_PREFIX='m';

Object.assign(App.prototype, {
  _initKeybarSettings(){
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
    add.addEventListener('change',sync);
    btn.addEventListener('click',()=>{
      const m=this._keybarDraft();
      if(!mkbMacroValid(m)) return;
      const l=lbl.value.trim();
      if(l) m.label=l;
      m.id=KEYBAR_MACRO_ID_PREFIX+Date.now().toString(36);
      lbl.value='';
      this._keybarSet(keybarAddMacro(keybarCfg,m));
    });
    sec.querySelector('.kbc-reset').addEventListener('click',()=>this._keybarSet(keybarReset(keybarCfg)));
    const list=sec.querySelector('.kbc-list');
    list.addEventListener('change',e=>{
      const row=e.target.closest('.kbc-row');
      if(row&&e.target.classList.contains('kbc-on')) this._keybarSet(keybarToggle(keybarCfg,row.dataset.id,e.target.checked));
    });
    list.addEventListener('click',e=>{
      const b=e.target.closest('button[data-act]');
      const row=b&&b.closest('.kbc-row');
      if(!row) return;
      const id=row.dataset.id;
      if(b.dataset.act==='del') this._keybarSet(keybarRemoveMacro(keybarCfg,id));
      else this._keybarSet(keybarMove(keybarCfg,id,b.dataset.act==='up'?-1:1));
    });
    sync();
    this._keybarPaint();
  },

  /** 추가 줄이 지금 가리키는 조합. */
  _keybarDraft(){
    const add=document.querySelector('#ds-keybar .kbc-add');
    const on=c=>add.querySelector(c).checked;
    return {key:add.querySelector('.kbc-key').value,ctrl:on('.kbc-ctrl'),alt:on('.kbc-alt'),shift:on('.kbc-shift')};
  },

  _keybarSet(cfg){
    keybarCfg=cfg;
    this._keybarApply();
    this.saveSettings();
  },

  /** 키바는 세워진 뒤에만 다시 그린다 — 부팅의 설정 얹기가 `initMobileKeybar` 보다 먼저 올 수 있다. */
  _keybarApply(){
    if(this.modKbd){ this._mkbRender(); this.mkbRefresh() }
    this._keybarPaint();
  },

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
      row.append(lab,name,sw,btn('up','arrow-up','Move up',i===0),btn('down','arrow-down','Move down',i===rows.length-1));
      if(k.macro) row.appendChild(btn('del','trash','Delete macro',false));
      list.appendChild(row);
    });
  },
});
