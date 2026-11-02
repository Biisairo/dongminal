// @ts-check
/**
 * 문서 비동기 적용의 토큰 규칙 (REPO_FIX 03 §3A-5).
 *
 * 디스크 내용을 문서에 넣는 비동기 작업(초기 로드·refresh·다시 열기·저장 완료)은
 * 시작할 때 토큰을 잡고, 적용 직전에 그 토큰이 아직 유효한지 묻는다 — ① 그 문서가
 * 그 경로로 레지스트리에 살아 있고 ② 세대(gen)가 같고 ③ 버퍼(`EdBuffer`)가 같고 판 번호
 * 가 같을 때만 적용한다. 하나라도 다르면 버린다.
 *
 *   이전 동작: 요청 전에만 dirty 를 보고, 응답 도착 후에는 확인이 없었다 — refresh
 *             가 요청 뒤의 편집을 덮고, 로딩 중 파괴된 편집기가 고아 모델을 남겼다
 *   새  동작: 적용 직전 재확인
 *   이유:     #3 #9. 05 의 git Diff 뷰도 이것을 쓴다
 *
 * 순수 함수다 — 레지스트리(경로 → 문서 Map)와 문서를 인자로 받는다.
 */

/**
 * @param {{gen:number, buf:any}} doc
 * @param {string} path
 * @returns {{doc:any, gen:number, buf:any, ver:(number|null), path:string}}
 */
function docTokenOf(doc, path) {
  return {
    doc, path, gen: doc.gen,
    buf: doc.buf || null,
    ver: doc.buf ? doc.buf.version : null,
  };
}

/**
 * 버퍼가 같은 객체이고 판 번호가 같아야 한다. 판 번호는 실행 취소에도 오른다 — 요청 뒤에
 * 고쳤다가 되돌렸어도 응답을 버린다(덮어쓸 위험 쪽으로 기울지 않는다).
 *
 * @param {{doc:any, gen:number, buf:any, ver:(number|null), path:string}} tok
 * @param {Map<string,any>|null|undefined} registry
 */
function docTokenValid(tok, registry) {
  if (!tok || !registry) return false;
  const cur = registry.get(tok.path);
  if (cur !== tok.doc) return false;
  if (cur.gen !== tok.gen) return false;
  if ((cur.buf || null) !== tok.buf) return false;
  return (cur.buf ? cur.buf.version : null) === tok.ver;
}
