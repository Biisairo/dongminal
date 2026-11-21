/**
 * Remote Terminal — App 레이아웃 프리셋 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 설정창의 프리셋 패널은 `settings-presets.js` 의 `PresetsSection` 이다 (REFACTOR3_FE_SETTINGS_SRS 8d). 여기 남는 것은
 * 설정창 밖에서도 도는 둘이다 — 프리셋으로 창을 만드는 `_loadPreset`(사이드바 단추·패널의 불러오기)과 사이드바의
 * 기본 프리셋 단추 칠하기(부팅과 설정 setter 가 설정창보다 먼저 부른다).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  async _loadPreset(idx){
    const preset=layoutPresets[idx];if(!preset)return;
    // Create new window with preset layout
    await this._mkWindow();
    const s=this.aw();if(!s)return;
    // Build layout from preset, creating panes as needed
    const build=async(tpl)=>{
      if(!tpl)return null;
      if(tpl.type==='pane'){
        const tabs=[];
        for(let i=0;i<tpl.tabCount;i++){
          const p=await this._newTool();
          tabs.push({id:newEntityId(),name:TAB_NAME_DEFAULT,type:TAB_TYPE_TERMINAL,toolId:p.id});
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
    const built=await build(preset.layout);
    // 프리셋이 빈 layout 을 담고 있어도 `_mkWindow` 가 만든 layout 을 덮어쓰지
    // 않는다 — 덮어쓰면 창 필터(FR-EDT-49)가 그 일반 창을 지우고 도구만 남는다.
    if(built) s.layout=built;
    this.setFocusState(firstPane(s.layout)?.id||null, s);
    await this.save();this.render();
  },

  // FR-OPT-1-12 (FEC-8): 사이드바의 기본 프리셋 버튼. 값을 얹는 자리(설정 setter)와
  // 목록을 그리는 자리가 같은 손을 부른다 — 다른 창에서 바뀐 기본 프리셋도 따라온다.
  _presetButtonPaint(){
    const pbtn=document.getElementById('add-preset');
    if(pbtn)pbtn.style.display=defaultPreset>=0&&layoutPresets[defaultPreset]?'':'none';
  },
});
