/**
 * Remote Terminal — App 검색 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 터미널 찾기 줄. `ToolController` 의 부품 `.search` 다(REFACTOR3_FE_APPCTL_SRS 9j, 옛 `app-search.js`).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 *
 * PERF 3.4.12.4 (D-43): 이 클래스는 부팅 껍데기다. 찾기 줄 본문과 vendor addon-search 는 `search` 묶음
 * (`tool-search-bar.js` 가 이 원형에 얹는다)이고, 찾기 줄을 처음 열 때 `toggleSearch` 가 싣는다. 실린 뒤 살아 있는
 * 터미널 모두에 addon 을 붙이고, 그 뒤 새 터미널은 `attachIfReady` 로 바로 붙는다. `focusedTerminal` 은 상태 바·git·
 * tool-life 가 부팅 때 부르므로 여기 남는다. 묶음이 실리기 전에는 찾기 줄이 열리지 않으므로 줄의 처리기(doSearch 등)가
 * 불리지 않는다.
 */
class ToolSearch extends Controller {
  // ── Search ──
  toggleSearch(){
    if(Screens.ready('search')){this._toggleSearch();return Promise.resolve()}
    return Screens.load('search').then(()=>{
      for(const p of this.app.tools.values())if(p.term&&!p.search)this._searchAttach(p);
      this._toggleSearch();
    },()=>{});
  }
  /** 터미널이 설 때(`_loadAddons`) 부른다 — 묶음이 실렸으면 addon 을 붙이고, 아니면 첫 열기가 붙인다. */
  attachIfReady(p){ if(Screens.ready('search')) this._searchAttach(p) }
  clearAllSearchDecorations(){
    for(const p of this.app.tools.values())if(p.search)p.search.clearDecorations();
  }
  _searchOpen(){return !document.getElementById('search-bar').hidden}
  researchIfOpen(){
    if(!this._searchOpen())return;
    this.app.timers.after(SEARCH_FIRST_DELAY_MS,()=>this.doSearch('next'),{owner:'app',label:'search-first'});
  }
  focusedTerminal(){
    if(!this.app.focused)return null;
    const s=this.app.tool.life.aw();if(!s)return null;
    const pn=findPane(s.layout,this.app.focused);if(!pn)return null;
    const tab=pn.tabs.find(x=>x.id===this.app.slot.paneTab(pn));
    if(!tab||tab.type!==TAB_TYPE_TERMINAL)return null;
    return this.app.tools.get(tab.toolId);
  }
}

Screens.register('search');
