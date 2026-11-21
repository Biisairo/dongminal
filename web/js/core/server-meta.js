/**
 * Remote Terminal — 서버가 정하는 상한 (`GET /api/meta`, SERVER_DRIVEN_ACTIONS_SRS F-4 · K-c · K-d)
 *
 * 부팅 때 `applyServerMeta` 가 서버의 답으로 채운다. 받기 전(0·빈 목록)에는 자르지 않는다.
 * constants.js 바로 뒤에 로드된다 (REFACTOR3_FE_REST2_SRS FR-FR2-5).
 */
/**
 * 창·탭 이름의 길이 상한 (`12-func-ui.md FUI-18`).
 *
 *   이전 동작: **만들 때만** 잘랐다 — `app-layout.js`(지금 `layout-*.js`) 네 자리의 `.slice(0,64)`.
 *             이름을 **바꾸는** 두 자리(`renameTab`·`rename`)는 자르지 않아,
 *             수천 자를 넣으면 워크스페이스 JSON 과 사이드바 폭이 그대로 받았다
 *   새  동작: 만들기와 바꾸기가 **같은 상한**을 지난다
 *   이유:     상한이 한쪽에만 있으면 그것은 상한이 아니다 — 우회로가 화면에
 *             버젓이 있다
 */
/*
 * SERVER_DRIVEN_ACTIONS_SRS F-4 (FR-SDA-54): 상한의 주인은 **서버**다. 부팅 때
 * `GET /api/meta` 의 `entityNameMax` 를 받아 여기 둔다(`applyServerMeta`). 받기 전(0)에는
 * 자르지 않는다 — 화면이 상한을 지어내지 않는다. dmctl 은 서버가 같은 상한으로 거절한다.
 *	이전 동작: 화면이 64 를 따로 들고 있었고 서버는 길이를 보지 않았다
 */
let ENTITY_NAME_MAX=0;
/** 이름 하나를 그 상한으로 접는다. 만들기·바꾸기가 같은 자리를 지난다. */
function clampEntityName(s){
  const v=String(s==null?'':s);
  return ENTITY_NAME_MAX>0?v.slice(0,ENTITY_NAME_MAX):v;
}
/*
 * SERVER_DRIVEN_ACTIONS_SRS K-c·K-d (FR-SDA-80): 서버의 요청 상한(겹 스탬프·파일 표식·감시 등록)과
 * 다시 열기 인코딩 목록. 받기 전(0·빈 목록)에는 자르지 않고 다시 열기 항목이 없다 — 넘으면 서버의
 * 400 이 보인다.
 *	이전 동작: 화면이 512·512·1024 와 인코딩 넷을 따로 들고 있었다
 */
const serverMeta={fsStampMax:0,fileStampsMax:0,fsWatchDirsMax:0,encodings:[]};
/** 목록을 서버 상한으로 자른다. 상한을 모르면(0) 그대로다. */
function capToServer(list,max){return max>0&&list.length>max?list.slice(0,max):list}
/** `GET /api/meta` 의 답을 받는다. 모르는 값은 무시한다. */
function applyServerMeta(m){
  if(!m) return;
  if(Number.isInteger(m.entityNameMax)&&m.entityNameMax>0) ENTITY_NAME_MAX=m.entityNameMax;
  for(const k of ['fsStampMax','fileStampsMax','fsWatchDirsMax'])
    if(Number.isInteger(m[k])&&m[k]>0) serverMeta[k]=m[k];
  if(Array.isArray(m.encodings)&&m.encodings.every(e=>typeof e==='string')) serverMeta.encodings=m.encodings.slice();
}
