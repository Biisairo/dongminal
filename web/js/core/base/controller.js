/**
 * Controller — 화면 없는 조정자 (REFACTOR3_FE_BASE_SRS FR-FEB-12). App 의 주제별 일은 이것의 하위가 맡는다.
 * 앱을 `this.app` 으로 들고, 타이머·구독은 그 앱의 `timers`·`bus` 를 쓴다(`Component._hub`·`_channel`).
 */
class Controller extends Component {
  constructor(app,opts){
    super(opts);
    this.app=app;
  }
}
