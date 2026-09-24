// @ts-check
/**
 * 문서 비동기 적용의 토큰 규칙 (REPO_FIX 03 §3A-5).
 *
 * 디스크 내용을 모델에 넣는 비동기 작업(초기 로드·refresh·다시 열기·저장 완료)은
 * 시작할 때 토큰을 잡고, 적용 직전에 그 토큰이 아직 유효한지 묻는다 — ① 그 문서가
 * 그 경로로 레지스트리에 살아 있고 ② 세대(gen)가 같고 ③ 모델 판(alternativeVersionId)
 * 이 같을 때만 적용한다. 하나라도 다르면 버린다.
 *
 *   이전 동작: 요청 전에만 dirty 를 보고, 응답 도착 후에는 확인이 없었다 — refresh
 *             가 요청 뒤의 편집을 덮고, 로딩 중 파괴된 편집기가 고아 모델을 남겼다
 *   새  동작: 적용 직전 재확인
 *   이유:     #3 #9. 05 의 git Diff 뷰도 이것을 쓴다
 *
 * 순수 함수다 — 레지스트리(경로 → 문서 Map)와 문서를 인자로 받는다.
 */

/**
 * @param {{gen:number, model:any}} doc
 * @param {string} path
 * @returns {{doc:any, gen:number, altVer:(number|null), path:string}}
 */
function docTokenOf(doc, path) {
  return {
    doc, path, gen: doc.gen,
    altVer: doc.model ? doc.model.getAlternativeVersionId() : null,
  };
}

/**
 * @param {{doc:any, gen:number, altVer:(number|null), path:string}} tok
 * @param {Map<string,any>|null|undefined} registry
 */
function docTokenValid(tok, registry) {
  if (!tok || !registry) return false;
  const cur = registry.get(tok.path);
  if (cur !== tok.doc) return false;
  if (cur.gen !== tok.gen) return false;
  const alt = cur.model ? cur.model.getAlternativeVersionId() : null;
  return alt === tok.altVer;
}
