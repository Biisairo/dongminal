/**
 * GitPanel — 디렉터리 항목(서브모듈·중첩 저장소) 자리의 사유와 진입점 (GIT_DIR_ENTRY_SRS FR-DIR-21·22 ·
 * SUBMODULE_DIRTY_NOTICE_SRS). `panel-diff.js` 의 증강 분할이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-4 ·
 * FEU-22) — `_showTarget` 이 diff 대신 이 둘을 그린다.
 */
Object.assign(GitPanel.prototype, {
  /**
   * SUBMODULE_DIRTY_NOTICE_SRS FR-SDN-5·9: 디렉터리 항목의 사유.
   *
   * 서브모듈은 세 상태로 갈린다 — 여기서 커밋할 수 있는 몫(gitlink)이 있는가,
   * 서브모듈 **안**에만 있는 몫이 있는가. 종전에는 `f.sub` 를 참/거짓으로만 보아
   * "스테이지하면 담기는 행" 과 "아무리 눌러도 사라지지 않는 행" 이 같은 문장을
   * 받았다 (SRS §2.2).
   *
   * 성분이 하나도 없으면 종전 문구 그대로다 (FR-SDN-7). 중첩 저장소도 그대로다
   * (FR-SDN-11) — `sub` 가 비어 있어 가를 것이 없다.
   */
  _dirEntryNote(f){
    if(!f||!f.sub) return GIT_DIR_ENTRY_NOTE_NESTED;
    const p=gitSubParts(f.sub);
    if(p.commit&&p.inner) return GIT_SUB_NOTE_BOTH;
    if(p.commit) return GIT_SUB_NOTE_COMMIT;
    if(p.inner) return GIT_SUB_NOTE_INNER;
    return GIT_DIR_ENTRY_NOTE_SUB;
  },

  /**
   * FR-DIR-22: 디렉터리 항목 자리의 진입점 하나.
   *
   * 이미 Repo 목록에 있으면 **이동**이고, 없으면 **추가**다. 추가는
   * `/api/editors/add` 한 번이며 연동이 Git 핀까지 함께 만든다 (FR-EDT-33·39) —
   * 여기서 두 목록을 각각 건드리지 않는다.
   */
  _dirEntryActs(f){
    const app=this.app;
    if(!app||!f||!f.repo||!f.path) return [];
    // §3A-4: 어휘적 저장소 최상위 기준 — 창 루트가 하위 폴더여도 같은 항목을 가리킨다.
    const abs=this.absPath(f);
    const has=(app.edEntries?app.edEntries():[]).some(e=>e&&e.path===abs);
    const go=()=>{
      const w=app.edWindowFor&&app.edWindowFor(abs);
      if(w) app.switchWindow(w.id);
    };
    const acts=has
      ? [{label:GIT_DIR_ENTRY_GO,title:GIT_DIR_ENTRY_GO_TITLE,run:go}]
      : [{label:GIT_DIR_ENTRY_ADD,title:GIT_DIR_ENTRY_ADD_TITLE,run:async()=>{
          // 추가가 실패하면 창도 없다 — 성공했을 때만 옮긴다.
          if(await app.edMutate('/add',{path:abs})) go();
        }}];
    /**
     * UX_BATCH5_SRS FR-SUB-11: **서브모듈에만** 관리 자리로 가는 길을 더한다.
     *
     * 위의 둘과 목적이 다르다 — 그쪽은 서브모듈 **자신의** 창으로 가고, 이쪽은
     * 지금 저장소의 Submodules 탭이다 (init·update·sync 가 사는 자리).
     *
     * 중첩 저장소(`f.sub` 가 거짓)에는 붙이지 않는다: `.gitmodules` 에 없으므로
     * 그 목록에 서지 않고, 눌러도 자기 행이 없는 탭이 열린다 (FR-GIT-180).
     */
    if(f.sub) acts.push({
      label:GIT_DIR_ENTRY_SUBTAB,title:GIT_DIR_ENTRY_SUBTAB_TITLE,
      run:()=>this.openView('submodules'),
    });
    return acts;
  },
});
