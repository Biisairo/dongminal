/**
 * Controller — 화면 없는 조정자 (REFACTOR3_FE_BASE_SRS FR-FEB-12). App 의 주제별 일은 이것의 하위가 맡는다.
 * 앱을 `this.app` 으로 들고, 타이머·구독은 그 앱의 `timers`·`bus` 를 쓴다(`Component._hub`·`_channel`).
 */
class Controller extends Component {
  constructor(app,opts){
    super(opts);
    this.app=app;
  }

  /**
   * 위임자 표 (REFACTOR3_FE_APPCTL_SRS FR-FEA-4). `host` 원형에 이름마다 한 줄 메서드를 둔다 — 같은 인자로 대상의
   * 같은 이름을 부르고 답을 돌려준다. `to` 는 인스턴스에서 대상까지의 점 경로(`'settings.live'`)이거나
   * `(self, name, args) => 답` 이다. 부를 때 대상을 찾으므로 인스턴스에 갈아 끼운 것도 지난다.
   */
  static delegate(host,to,names){
    const path=typeof to==='string'?to.split('.'):null;
    for(const n of names){
      host.prototype[n]=path
        ?function(...a){ let o=this; for(const k of path) o=o[k]; return o[n](...a) }
        :function(...a){ return to(this,n,a) };
    }
  }
}
