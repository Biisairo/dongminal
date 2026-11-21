/**
 * GitPart — Git 패널 부품의 기반 (REFACTOR3_FE_GITPANEL_SRS FR-FEP-1).
 *
 * 패널(`GitPanel`)은 부품을 만들어 들고 공용 상태(대상·선택·뷰·관측 접근자)를 갖는다. 부품은 자기 메서드와
 * **혼자 쓰는 필드**를 갖고, 공용 필드·관측 접근자·`repo`·다른 부품의 메서드는 `this.p` 로 닿는다.
 * 해제는 패널의 `destroy` 가 한 번 부른다.
 */
class GitPart extends Component {
  constructor(panel){
    super();
    this.p=panel;
    this.app=panel.app;
  }
}
