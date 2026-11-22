/**
 * SettingsSection — 설정 탭 하나 (REFACTOR3_FE_SETTINGS_SRS FR-FES-1). 탭마다 하위 클래스 하나다(D-FES-5).
 *
 * `index.html` 의 `#panel-<tab>` 을 받아 쓴다 — 그 요소의 주인은 마크업이므로 `dispose()` 가 떼지 않는다.
 * 훅은 넷이다: `init()`(한 번 — 리스너는 `listen`·`own`) · `onOpen()`(설정을 열 때) · `onTab()`(그 탭을 고를 때) ·
 * `paint()`(칠하기 한 자리 — 기본은 선언한 행을 칠한다). 저장·적용은 소유 경로(`this.app.settings.apply`)로 부른다 — e2e·단위
 * 시험이 그 인스턴스의 메서드를 갈아 끼운다.
 *
 * 섹션을 드는 것은 `SettingsController`(`settings-controller.js`)다 — 세우기(`start`)·찾기(`section(tab)`)와
 * 열기·탭 훅의 순서가 그쪽에 있다(FR-FES-6·7).
 */
class SettingsSection extends View {
  constructor(app,tab){
    super();
    this.app=app;
    this.tab=tab;
    this.rows=[];
    this.adopt(document.getElementById('panel-'+tab));
  }

  /** `FormRow` 선언 배열을 행으로 세우고 리스너를 건다. 요소가 없는 행도 남는다(칠하기가 건너뛴다). */
  bindRows(decls){
    for(const d of decls) this.rows.push(new FormRow(d).bind(this));
  }

  init(){}

  onOpen(){}

  onTab(){}

  paint(){
    for(const r of this.rows) r.paint();
  }
}
