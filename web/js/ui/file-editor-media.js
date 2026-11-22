/**
 * FileEditorMedia — 편집기를 세우기 전의 판정과 편집기 대신 서는 화면 (EDITOR_GIT_UX_SRS 묶음 V · FILE_API_BOUNDARY_SRS FR-FAB-9).
 *
 * `FileEditor` 의 부품이다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 서버에 종류를 묻고(`probe`), 이진 파일·상한을 넘는 파일·
 * 그림은 편집기 대신 사유나 그림을 칸에 그린다. 칸의 `_init` 이 부른다.
 */
class FileEditorMedia {
  constructor(ed) {
    this.ed = ed;
  }

  /**
   * FR-EVW-1: 서버가 내용을 보고 판정한다 (FR-EVW-2) — 확장자는 근거가 아니다.
   *
   * FR-EVW-8: 종단이 없거나 실패하면 **텍스트로 가정한다.** 옛 서버에 붙은 새
   * 브라우저에서 편집기가 통째로 서지 않는 것보다, 지금까지의 동작을 유지하는
   * 편이 낫다.
   */
  async probe() {
    const r = await apiGet(FILE_PROBE_API, { query: { path: this.ed.filePath } });
    if (!r.ok) return { kind: FILE_KIND_TEXT };
    return r.data && r.data.kind ? r.data : { kind: FILE_KIND_TEXT };
  }

  /**
   * FR-FAB-9: 판정의 값은 **서버가 준 것**이다. `maxBytes` 가 없는 옛 서버에
   * 붙었으면 게이트를 걸지 않는다 — 옛 서버에서 편집기가 통째로 막히는 것보다
   * 지금까지의 동작을 유지하는 편이 낫다 (FR-EVW-8 과 같은 관대함이다).
   */
  overSizeLimit(probe) {
    const max = Number(probe && probe.maxBytes);
    const size = Number(probe && probe.size);
    if (!isFinite(max) || max <= 0 || !isFinite(size)) return false;
    return size > max;
  }

  // FR-FAB-9: 사유와 함께 **나가는 길 둘**을 준다. 막기만 하면 사용자는 그
  // 파일을 어떻게 보는지 모른 채 남는다.
  showTooLarge(probe) {
    const href = FILE_DOWNLOAD_API + '?path=' + encodeURIComponent(this.ed.filePath);
    this.ed.el.innerHTML =
      '<div class="fe-unsupported">' +
        '<div class="fe-unsup-title">' + FILE_TOO_LARGE_TITLE + '</div>' +
        '<div class="fe-unsup-path">' + escHtml(this.ed.filePath) + '</div>' +
        '<div class="fe-unsup-meta">' +
          escHtml(t('editor.size_with_limit',{size:this.fmtFileSize(probe.size),max:this.fmtFileSize(probe.maxBytes)})) +
        '</div>' +
        '<div class="fe-unsup-hint">' + FILE_TOO_LARGE_HINT + '</div>' +
        '<a class="fe-unsup-dl" download href="' + escHtml(href) + '">' + FILE_TOO_LARGE_DOWNLOAD + '</a>' +
      '</div>';
  }

  // FR-EVW-3: 열지 않고 사유를 보인다. 편집기를 세우지 않으므로 저장 경로
  // 자체가 생기지 않는다 (FR-EVW-7).
  showUnsupported(probe) {
    this.ed.el.innerHTML =
      '<div class="fe-unsupported">' +
        '<div class="fe-unsup-title">' + FILE_UNSUPPORTED_TITLE + '</div>' +
        '<div class="fe-unsup-path">' + escHtml(this.ed.filePath) + '</div>' +
        '<div class="fe-unsup-meta">' +
          escHtml(probe.mime || '') + ' · ' + escHtml(this.fmtFileSize(probe.size)) +
        '</div>' +
        '<div class="fe-unsup-hint">' + FILE_UNSUPPORTED_HINT + '</div>' +
      '</div>';
  }

  // FR-EVW-4: 원본 비율을 지키고 칸보다 크면 줄여 맞춘다. 바이트는
  // /api/file/raw 가 준다 — 이미지 MIME 만 인라인으로 나온다 (FR-EVW-5).
  showImage(probe) {
    const src = FILE_RAW_API + '?path=' + encodeURIComponent(this.ed.filePath);
    this.ed.el.innerHTML =
      '<div class="fe-image ui-scroll">' +
        '<img class="fe-img" alt="' + escHtml(this.ed.filePath) + '">' +
        '<div class="fe-img-meta"></div>' +
      '</div>';
    const img = this.ed.el.querySelector('.fe-img');
    const meta = this.ed.el.querySelector('.fe-img-meta');
    img.addEventListener('load', () => {
      meta.textContent = img.naturalWidth + '×' + img.naturalHeight +
        ' · ' + (probe.mime || '') + ' · ' + this.fmtFileSize(probe.size);
    });
    img.addEventListener('error', () => {
      meta.textContent = FILE_IMAGE_FAIL;
    });
    img.src = src;
  }

  /**
   * **파일 크기**의 표기 (M6 `FE-22`).
   *
   * `StatusBarController` 의 `_fmtMemSize` 와 **합치지 마라.** 겉이 비슷하고 이름도
   * 같았지만(`_fmtBytes`) 두 함수는 다른 값을 위한 것이다:
   *
   *   여기      파일 크기. **B·KB 가 뜻을 갖는다** — 수십 바이트짜리 파일이
   *             실재하고, 그것을 `0.0MB` 로 적으면 사실을 지운다. 단위 앞에
   *             공백이 있다
   *   statusbar 시스템 메모리. 언제나 MB 이상이고 공백이 없다
   *
   * 이름이 같았던 것이 `FE-22` 가 "두 벌" 로 읽은 이유다. 합치면 두 화면 중
   * 하나의 표기가 조용히 바뀐다 — 그래서 합치는 대신 **이름을 갈랐다**.
   */
  fmtFileSize(n) {
    const b = Number(n);
    if (!isFinite(b)) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
}
