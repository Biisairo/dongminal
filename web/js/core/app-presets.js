/**
 * Remote Terminal — App 레이아웃 프리셋 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 7개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── Layout Presets ──
  _initPresets(){
    document.getElementById('preset-save').addEventListener('click',()=>this._savePreset());
    this._renderPresets();
  },
  _savePreset(){
    const s=this._aw();if(!s)return;
    // Strip layout to just structure (remove toolIds, keep tab counts)
    const strip=n=>{
      if(!n)return null;
      if(n.type==='pane')return{type:'pane',tabCount:n.tabs?n.tabs.length:1};
      if(n.type==='split')return{type:'split',direction:n.direction,children:n.children.map(strip),sizes:n.sizes?[...n.sizes]:null};
      return null;
    };
    const layout=strip(s.layout);
    const name='프리셋 '+(layoutPresets.length+1);
    layoutPresets.push({name,layout});
    this._saveSettings();
    this._renderPresets();
  },
  async _loadPreset(idx){
    const preset=layoutPresets[idx];if(!preset)return;
    // Create new window with preset layout
    await this._mkWindow();
    const s=this._aw();if(!s)return;
    // Build layout from preset, creating panes as needed
    const build=async(tpl)=>{
      if(!tpl)return null;
      if(tpl.type==='pane'){
        const tabs=[];
        for(let i=0;i<tpl.tabCount;i++){
          const p=await this._newTool();
          tabs.push({id:newEntityId(),name:'Shell',type:'terminal',toolId:p.id});
        }
        const rid=newEntityId();
        return{type:'pane',id:rid,tabs,activeTab:tabs[0].id};
      }
      if(tpl.type==='split'){
        const children=[];
        for(const c of tpl.children){
          const built=await build(c);
          if(built)children.push(built);
        }
        return{type:'split',direction:tpl.direction,children,sizes:tpl.sizes?[...tpl.sizes]:null};
      }
      return null;
    };
    s.layout=await build(preset.layout);
    this._setFocus(firstPane(s.layout)?.id||null, s);
    await this._save();this.render();
  },
  _deletePreset(idx){
    layoutPresets.splice(idx,1);
    if(defaultPreset===idx)defaultPreset=-1;
    else if(defaultPreset>idx)defaultPreset--;
    this._saveSettings();
    this._renderPresets();
  },
  _renamePreset(idx){
    const item=document.querySelector(`.preset-item[data-idx="${idx}"] .preset-name`);
    if(!item)return;
    const inp=document.createElement('input');inp.className='preset-rename-input';
    inp.value=layoutPresets[idx].name;inp.style.cssText='background:var(--bg);border:1px solid var(--accent);border-radius:3px;padding:2px 6px;color:var(--text);font-size:12px;width:100%;outline:none';
    item.replaceWith(inp);inp.focus();inp.select();
    const save=()=>{
      layoutPresets[idx].name=inp.value.trim()||layoutPresets[idx].name;
      this._saveSettings();this._renderPresets();
    };
    inp.addEventListener('blur',save);
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape'){inp.value=layoutPresets[idx].name;save()}e.stopPropagation()});
  },
  _describeLayout(layout){
    if(!layout)return'';
    if(layout.type==='pane')return`탭 ${layout.tabCount}개`;
    if(layout.type==='split'){
      const dir=layout.direction==='horizontal'?'가로':'세로';
      const descs=layout.children.map(c=>this._describeLayout(c)).filter(Boolean);
      return`${dir} 분할 [${descs.join(', ')}]`;
    }
    return'';
  },
  _renderPresets(){
    const el=document.getElementById('preset-list');if(!el)return;
    el.innerHTML='';
    // Update sidebar preset button visibility
    const pbtn=document.getElementById('add-preset');
    if(pbtn)pbtn.style.display=defaultPreset>=0&&layoutPresets[defaultPreset]?'':'none';
    if(!layoutPresets.length){
      el.innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">저장된 프리셋이 없습니다</div>';
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
      const star=document.createElement('button');star.className='preset-btn';
      star.textContent=i===defaultPreset?'★':'☆';star.title='기본 프리셋으로 설정';
      star.addEventListener('click',e=>{e.stopPropagation();defaultPreset=defaultPreset===i?-1:i;this._saveSettings();this._renderPresets()});
      item.appendChild(star);
      // Load button
      const load=document.createElement('button');load.className='preset-btn';load.textContent='▶';load.title='불러오기';
      load.addEventListener('click',e=>{e.stopPropagation();this._loadPreset(i)});
      item.appendChild(load);
      // Delete button
      const del=document.createElement('button');del.className='preset-btn del';del.textContent='✕';del.title='삭제';
      del.addEventListener('click',e=>{e.stopPropagation();this._deletePreset(i)});
      item.appendChild(del);
      el.appendChild(item);
    });
  },
});
