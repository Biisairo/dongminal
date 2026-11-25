/**
 * Remote Terminal — 주의 센터 팝오버 (UIUX_OVERHAUL_SRS FR-ACT-8·9, D-7)
 *
 *   이전 동작: 배지가 활동 패널의 주의 구역을 연다 (FR-ACT-1)
 *   새  동작: 배지 아래에 팝오버가 뜬다. 패널은 열리지 않는다
 *   이유:     FR-ACT-1 이 한 표면으로 모은 넷에는 **질문이 둘** 있었다 —
 *             주의는 "나를 기다리는 것이 있나" 이고 나머지 셋은 "지금 뭐가
 *             돌고 있나" 다. 물음이 다르면 자리도 다르다
 *
 * `AttnCenter` 는 `AttnController` 의 부품이다(`attn.center`, REFACTOR3_FE_APPCTL_SRS 9b).
 *
 * 새로 짓지 않았다 — `e9849d4d`("조회는 한 자리에 모인다")가 지운 넷을 그
 * 커밋의 부모에서 그대로 회수했다. 행의 규칙(`.attn-item`)은 지운 적이 없다.
 *
 * **제 파일에 사는 이유.** 되받아 온 넷이 `attn-controller.js`(옛 `app-attn.js`)를 500줄 위로 밀었다
 * (FR-STR-40). 가르는 자리가 표면의 경계와 같다 — 이 파일은 **띄우는 일**만
 * 알고, 알람의 수명(`_attn`·`_attnClear`·배지)은 `AttnController` 의 것이다.
 *
 * PERF 3.4.12.10 (D-47): 이 파일은 부팅 껍데기다. 닫기는 문서 클릭·알림 걷기가 부르므로 여기 있고, 열기·그리기의 본체는
 * `uiact` 묶음의 `attn-center-view.js` 가 이 원형에 바꿔 단다. 센터가 열려 있을 때만 그리므로 그 전에는 묶음이 서 있다.
 *
 * 로드 순서 계약: `app.js` 뒤, `attn-controller.js` 뒤.
 */

class AttnCenter extends Controller {

  _attnCenterClose(){
    const center=document.getElementById('attn-center');
    if(center) center.classList.remove('open');
  }

  _attnCenterToggle(...a){ return Screens.call('uiact',this,'_attnCenterToggle',a) }
  _attnCenterRender(...a){ return Screens.call('uiact',this,'_attnCenterRender',a) }
}
