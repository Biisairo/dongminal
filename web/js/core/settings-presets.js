/**
 * PresetsSection — Settings ▸ Presets (REFACTOR3_FE_SETTINGS_SRS 8d, 옛 `app-presets.js` 의 패널 부분).
 *
 * 목록·저장·이름 바꾸기·지우기 확인·기본 프리셋 별. 프리셋을 **불러오는** `_loadPreset`(창을 만든다)과 사이드바의
 * 기본 프리셋 단추 칠하기 `_presetButtonPaint`(부팅에서 설정창보다 먼저 돈다)는 App 에 남는다(위임자, 본체는 `layout-window-state.js`).
 * e2e 계약(`_renderPresets`·`_savePreset`)은 App 의 위임자가 이 섹션에 잇는다(FR-FES-9).
 */
class PresetsSection extends SettingsSection {
  constructor(app){ super(app,'presets') }

  init(){
    this.listen(document.getElementById('preset-save'),'click',()=>this._savePreset());
    this._renderPresets();
  }

  /** 설정을 열 때·이 탭을 고를 때 목록을 다시 그린다. */
  onOpen(){ this._renderPresets() }

  onTab(){ this._renderPresets() }

  // 프리셋의 대상은 **일반 창**이다. Editor 창은 pane 이 없는 것이 정상이고
  // (FR-EDT-55) 그 layout(null)을 저장하면 불러오기가 `_mkWindow` 로 만든 창의
  // layout 을 null 로 덮어써, 그 창이 다음 로드의 창 필터에 지워지고 도구만 남는다.
  //
  // 활성 창이 Editor·Git 창이면 **직전에 활성이었던 일반 창**으로 간다 —
  // `gitBackTarget`(FR-GIT-183a)과 같은 규약이다. 기억이 없으면 목록의 첫 일반
  // 창이고, 일반 창이 하나도 없으면 null 이다.
  _presetSource(){
    const a=this.app.aw();
    if(a&&!this.app.git.isKindWin(a)) return a;
    const plain=this.app.git.plainWindows();
    return plain.find(s=>s.id===this.app._lastPlainWindow)||plain[0]||null;
  }

  _savePreset(){
    const s=this._presetSource();
    // Strip layout to just structure (remove toolIds, keep tab counts)
    const strip=n=>{
      if(!n)return null;
      if(n.type==='pane')return{type:'pane',tabCount:n.tabs?n.tabs.length:1};
      if(n.type==='split')return{type:'split',direction:n.direction,children:n.children.map(strip),sizes:n.sizes?[...n.sizes]:null};
      return null;
    };
    const layout=s?strip(s.layout):null;
    // 빈 layout 을 프리셋으로 남기지 않는다. 눌렀는데 아무 일도 일어나지 않으면
    // 사용자는 고장으로 읽으므로 사유를 화면에 남긴다.
    if(!layout){this._presetMsg(PRESET_SAVE_NO_PLAIN);return}
    const name=t('presets.default_name',{n:layoutPresets.length+1});
    layoutPresets.push({name,layout});
    this.app.settings.apply.saveSettings();
    this._renderPresets();
  }
  _deletePreset(idx){
    layoutPresets.splice(idx,1);
    if(defaultPreset===idx)defaultPreset=-1;
    else if(defaultPreset>idx)defaultPreset--;
    this.app.settings.apply.saveSettings();
    this._renderPresets();
  }
  _renamePreset(idx){
    const item=document.querySelector(`.preset-item[data-idx="${idx}"] .preset-name`);
    if(!item)return;
    const inp=document.createElement('input');inp.className='preset-rename-input';
    inp.value=layoutPresets[idx].name;
    inp.style.cssText='background:var(--bg);border:1px solid var(--accent);border-radius:var(--radius-sm);'+
      'padding:2px 6px;color:var(--text);font-size:12px;width:100%;outline:none';
    item.replaceWith(inp);inp.focus();inp.select();
    const save=()=>{
      layoutPresets[idx].name=inp.value.trim()||layoutPresets[idx].name;
      this.app.settings.apply.saveSettings();this._renderPresets();
    };
    inp.addEventListener('blur',save);
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape'){inp.value=layoutPresets[idx].name;save()}e.stopPropagation()});
  }
  _describeLayout(layout){
    if(!layout)return'';
    if(layout.type==='pane')return tn('presets.tabs',layout.tabCount);
    if(layout.type==='split'){
      const dir=layout.direction==='horizontal'?t('presets.horizontal'):t('presets.vertical');
      const descs=layout.children.map(c=>this._describeLayout(c)).filter(Boolean);
      return t('presets.split',{dir,children:descs.join(', ')});
    }
    return'';
  }
  // 저장을 거절한 사유가 앉는 자리. 목록 위에 두어 방금 누른 버튼과 가깝게 둔다.
  _presetMsg(text){
    const host=document.getElementById(PRESET_PANEL_ID);if(!host)return;
    let el=host.querySelector('.'+PRESET_MSG_CLASS);
    if(!el){
      el=document.createElement('div');el.className=PRESET_MSG_CLASS;
      host.insertBefore(el,host.firstChild);
    }
    el.textContent=text||'';
  }

  _renderPresets(){
    // 목록이 다시 그려지는 것은 저장·삭제·이름변경이 성공했을 때다 — 지난 사유는
    // 그 순간 더 이상 사실이 아니다.
    this._presetMsg('');
    const el=document.getElementById('preset-list');if(!el)return;
    el.innerHTML='';
    this.app._presetButtonPaint();
    if(!layoutPresets.length){
      el.innerHTML='<div style="color:var(--text-hint);font-size:12px;text-align:center;padding:20px"></div>';
      el.firstChild.textContent=t('presets.empty');
      return;
    }
    layoutPresets.forEach((p,i)=>{
      const item=document.createElement('div');item.className='preset-item';item.dataset.idx=i;
      if(i===defaultPreset)item.style.borderColor='var(--accent)';
      const info=document.createElement('div');info.className='preset-info';
      const name=document.createElement('div');name.className='preset-name';name.textContent=p.name;
      name.addEventListener('dblclick',e=>{e.stopPropagation();this._renamePreset(i)});
      const desc=document.createElement('div');desc.className='preset-desc';desc.textContent=this._describeLayout(p.layout);
      info.appendChild(name);info.appendChild(desc);
      item.appendChild(info);
      // Star (default) button
      // UI_KIT_SRS FR-GLY-4: 채움과 획으로 기본 여부를 가른다 — 별 두 글자가
      // 하던 일을 같은 모양의 두 상태가 한다.
      const star=UIKit.button({icon:'star',iconFill:i===defaultPreset,
        title:TIP_PRESET_DEFAULT,kind:'ghost'});
      star.addEventListener('click',e=>{e.stopPropagation();defaultPreset=defaultPreset===i?-1:i;this.app.settings.apply.saveSettings();this._renderPresets()});
      item.appendChild(star);
      // Load button. 로드맵 M7 `FUI-25`: 실패는 **보인다** — 도구 생성이
      // 거절되면 종전에는 창만 비어 있었다.
      const load=UIKit.button({icon:'play',title:TIP_PRESET_LOAD,kind:'ghost'});
      load.addEventListener('click',e=>{e.stopPropagation();this.app._loadPreset(i).catch(err=>this.app._notify(PRESET_LOAD_FAIL.replace('%s',String(err&&err.message||err))))});
      item.appendChild(load);
      // Delete button. `FUI-25`: 인라인 확인을 지난다 (Runs·백그라운드 목록의
      // `예/아니오` 와 같은 규약 — 모달 위의 모달을 띄우지 않는다).
      if(this._presetConfirm===i){
        const wrap=document.createElement('span'); wrap.className='preset-confirm';
        const q=document.createElement('span'); q.className='preset-q'; q.textContent=PRESET_DEL_Q;
        const yes=UIKit.button({label:t('core.yes'),title:TIP_PRESET_DEL,kind:'danger',size:'sm',cls:'preset-yes'});
        yes.addEventListener('click',e=>{e.stopPropagation();this._presetConfirm=-1;this._deletePreset(i)});
        const no=UIKit.button({label:t('core.no'),title:TIP_PRESET_KEEP,size:'sm',cls:'preset-no'});
        no.addEventListener('click',e=>{e.stopPropagation();this._presetConfirm=-1;this._renderPresets()});
        wrap.append(q,yes,no);
        item.appendChild(wrap);
      }else{
        const del=UIKit.button({icon:'x',title:TIP_PRESET_DEL,kind:'ghost',cls:'preset-del'});
        del.addEventListener('click',e=>{e.stopPropagation();this._presetConfirm=i;this._renderPresets()});
        item.appendChild(del);
      }
      el.appendChild(item);
    });
  }
}
