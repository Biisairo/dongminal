/**
 * SettingsSection — 설정 탭 하나 (REFACTOR3_FE_SETTINGS_SRS FR-FES-1). 탭마다 하위 클래스 하나다(D-FES-5).
 *
 * `index.html` 의 `#panel-<tab>` 을 받아 쓴다 — 그 요소의 주인은 마크업이므로 `dispose()` 가 떼지 않는다.
 * 훅은 넷이다: `init()`(한 번 — 리스너는 `listen`·`own`) · `onOpen()`(설정을 열 때) · `onTab()`(그 탭을 고를 때) ·
 * `paint()`(칠하기 한 자리 — 기본은 선언한 행을 칠한다). 저장·적용은 `this.app` 을 거쳐 부른다 — e2e·단위 시험이
 * App 인스턴스의 메서드를 갈아 끼운다.
 *
 * 섹션은 8e 의 `SettingsController` 가 들 때까지 이 클래스의 정적 `WeakMap` 이 앱별로 든다(§6 8a) — App 에 필드를
 * 새로 얹지 않는다(INV-S5).
 */
class SettingsSection extends View {
  static _byApp=new WeakMap();

  constructor(app,tab){
    super();
    this.app=app;
    this.tab=tab;
    this.rows=[];
    this.adopt(document.getElementById('panel-'+tab));
  }

  /** 섹션을 앱에 등록하고 `init()` 을 부른다. */
  static start(app,section){
    let m=SettingsSection._byApp.get(app);
    if(!m) SettingsSection._byApp.set(app,m=new Map());
    m.set(section.tab,section);
    section.init();
    return section;
  }

  static of(app,tab){
    const m=SettingsSection._byApp.get(app);
    return (m&&m.get(tab))||null;
  }

  /** 등록한 순서다. */
  static all(app){
    const m=SettingsSection._byApp.get(app);
    return m?[...m.values()]:[];
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
