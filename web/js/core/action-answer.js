/**
 * Dongminal — 서버의 답을 컨트롤 상태로 (SERVER_DRIVEN_ACTIONS_SRS M-8).
 *
 * 컨트롤을 켤지 끌지는 **서버의 답**과 **진행 중** 둘만으로 정한다 (FR-SDA-6·7).
 * 화면이 자기 규칙으로 판정하면 서버와 두 벌이 되고, 두 벌은 이미 어긋났다(SRS §2.1).
 * 사유 문구는 답의 코드로 카탈로그(`why.<code>`)에서 고른다 (D-SDA-5).
 *
 * @param {{ok:boolean, why?:string, args?:Object}|null|undefined} answer  서버의 답. 없으면 아직 모른다
 * @param {boolean} pending  사용자가 누른 요청의 응답을 기다리는 중
 * @returns {{enabled:boolean, why:string}}
 */
function actionState(answer,pending){
  if(pending) return {enabled:false,why:''};
  if(!answer) return {enabled:false,why:t('why.loading')};
  if(answer.ok) return {enabled:true,why:''};
  return {enabled:false,why:t('why.'+answer.why,answer.args)};
}
