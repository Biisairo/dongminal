/**
 * 탭 배지의 판정 한 벌 (REFACTOR3_FE_BASE_SRS FR-FEB-15 · FE_OBJECT_MODEL 계열 9).
 *
 * 수가 0 보다 크면 수를 보인다. 0·null 은 말하지 않는다(UI_POLISH_SRS FR-UIP-7). 수가 없을 때
 * `opts.dot` 이 참이면 알람 점이다(PEER_CHAT_SRS FR-PCH-81).
 *
 * @returns {{shown:boolean, text:string, dot:boolean}}
 */
function badgeOf(n,opts){
  const shown=Number(n)>0;
  return {shown, text:shown?String(n):'', dot:!shown&&!!(opts&&opts.dot)};
}
