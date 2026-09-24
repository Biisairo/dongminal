/**
 * Remote Terminal — 상태바의 접힘 (UIUX_OVERHAUL_SRS FR-HIE-4, 개정)
 *
 * 이 파일이 따로 있는 이유는 크기 게이트 때문만이 아니다. 접힘은 **한 가지 일**
 * 이다 — 순위표 하나, 재는 법 하나, 펼치는 길 하나. `app-statusbar.js` 는
 * 지표를 만들고 백그라운드 모달을 여는 파일이고, 그 둘과 이 일은 함께 고쳐지지
 * 않는다.
 *
 * `app-statusbar.js` 이후에 로드된다 — `App.prototype` 에 얹기만 하므로 순서의
 * 요구는 `app.js` 뒤라는 것뿐이다.
 */

/**
 * UIUX_OVERHAUL_SRS FR-HIE-4 (개정 — 사용자 결정 2026-09-21): 지표의 **순위표**.
 *
 * 폭이 모자랄 때 낮은 것부터 숨는다. `STATUS_BAR_REFLOW_SRS` FR-SBR-1·3 이
 * *"어떤 폭에서도 켜 둔 지표는 전부 화면에 있다"* 고 정한 것과 충돌하므로,
 * **접힘은 모바일에만 적용한다** — 데스크톱은 종전대로 줄을 넘긴다. 접수의
 * 근거(§2.6)가 모바일에서 상태바가 3줄이 되어 터미널 세로를 먹는 것이었고,
 * 그 근거만 해소한다.
 *
 * 표가 여기 한 벌인 것이 요구다. 순위를 마크업에 흩으면 지표를 더할 때마다
 * 어느 단인지 다시 판단하게 된다.
 *
 *   1  활동 진입점 · 연결 상태 · 현재 위치 — 이것이 없으면 상태바가 아니다
 *   2  호스트 · 지연 · 치수
 *   3  CPU · MEM · DISK · 업타임
 */
const STATUSBAR_PRI={activity:1,connection:1,location:1,cwd:1,hostname:2,latency:2,termsize:2,encoding:2,
  cpu:3,memory:3,disk:3,uptime:3};
/** 낮은 단부터 숨긴다. 1단은 숨기지 않으므로 목록에 없다. */
const STATUSBAR_FOLD_ORDER=[3,2];

Object.assign(App.prototype, {
  /**
   * FR-HIE-4: 접힘 토글의 배선. 리스너는 한 번이다 — 지표 재생성 주기에
   * 종속되면 안 된다 (FR-RPT-3).
   *
   * **대상은 상태바 자신이다** (사용자 결정 2026-09-21). 버튼을 두지 않은 것은
   * 실측 때문이다: `body.mobile .ui-btn{min-height:var(--touch-min)}` (44px) 가
   * 22px 짜리 바를 **49px 로 키워** 접기로 아낀 30px 을 그대로 토해냈다. 이
   * 요구가 존재하는 이유가 그 30px 이므로 버튼은 답이 아니다.
   *
   * NFR-3(터치 하한)을 깨지 않는다 — 하한은 **컨트롤**의 것이고 여기서는 새
   * 컨트롤을 놓지 않았다. 대상은 폭 전체를 쓰는 바이고, 접힘은 모바일에만 있어
   * 키보드 경로가 필요한 자리도 아니다. 상태는 `::after` 의 꺾쇠가 말한다.
   */
  _initStatusBarFold(){
    this._sbExpanded=false;
    const sbar=document.getElementById('status-bar');
    if(!sbar) return;
    sbar.addEventListener('click',e=>{
      // 새 판 배지는 링크다 — 삼키면 눌러도 아무 일이 없다.
      if(e.target.closest('.sb-update')) return;
      if(!document.body.classList.contains('mobile')) return;
      if(!this._sbExpanded&&!sbar.classList.contains('sb-folded')) return;
      this._sbExpanded=!this._sbExpanded;
      this._foldStatusBar();
    });
  },

  /**
   * FR-HIE-4 (개정): 모바일에서 상태바를 **한 줄**로 접는다.
   *
   *   이전 동작: 폭이 모자라면 줄을 넘겼다 — 390px 에서 3줄이 되어 터미널 세로를
   *             50px 가까이 먹었다 (§2.6 · 기준선 06)
   *   새  동작: 모바일에서는 넘기지 않고 낮은 순위부터 숨긴다. 숨은 것이 있으면
   *             상태바를 눌러 펼친다 (펼친 상태가 종전 동작이다)
   *   이유:     사용자 결정 2026-09-21. `STATUS_BAR_REFLOW_SRS` 의 *"2줄 3줄로
   *             표시"* 는 데스크톱의 요구였고 그쪽은 그대로 산다
   *
   * 측정은 `scrollWidth > clientWidth` 다 — 모바일에서 `#sb-items` 가
   * `nowrap` 이므로 넘친 만큼이 그 차로 나온다.
   */
  _foldStatusBar(){
    const bar=document.getElementById('sb-items');
    const sbar=document.getElementById('status-bar');
    if(!bar||!sbar) return;
    const mobile=document.body.classList.contains('mobile');
    // 데스크톱에서 접은 적이 없으면 손댈 것이 없다 — 이 함수는 1초마다 불리고,
    // 아무 이유 없이 클래스를 쓰면 그때마다 레이아웃이 무효가 된다 (FR-RPT-3 의 뜻).
    if(!mobile&&!sbar.classList.contains('sb-folded')
       &&!sbar.classList.contains('sb-expanded')) return;
    for(const el of bar.children) el.classList.remove('sb-hidden');
    sbar.classList.toggle('sb-expanded',mobile&&this._sbExpanded);
    let folded=false;
    if(mobile&&!this._sbExpanded){
      for(const pri of STATUSBAR_FOLD_ORDER){
        if(bar.scrollWidth<=bar.clientWidth+1) break;
        for(const el of bar.children){
          if(el.dataset.pri===String(pri)){el.classList.add('sb-hidden');folded=true}
        }
      }
    }
    sbar.classList.toggle('sb-folded',folded);
    // 누를 수 있다는 사실과 무엇이 일어나는지를 툴팁이 말한다. 접을 것도 펼칠
    // 것도 없으면 지운다 — 남겨 두면 데스크톱에서 거짓말을 한다.
    if(mobile&&(folded||this._sbExpanded)){
      sbar.title=t(this._sbExpanded?'statusbar.fold_less':'statusbar.fold_more');
    }else if(sbar.title){
      sbar.removeAttribute('title');
    }
  },
});
