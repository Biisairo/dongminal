/**
 * View — 화면 부품의 기반 (REFACTOR3_FE_BASE_SRS FR-FEB-11). 화면 부품은 모두 이것의 하위다.
 *
 * `el` 은 자기 루트 요소다. `mount(host)` 는 처음 한 번 `build()` 로 `el` 을 만들고 `host` 에 붙인 뒤
 * `render()` 를 부른다. 이미 `index.html` 에 있는 DOM 을 쓰는 하위는 `adopt(el)` 로 받는다(D-FEB-3) —
 * 그 요소의 주인은 `index.html` 이므로 `dispose()` 가 떼지 않는다.
 */
class View extends Component {
  constructor(opts){
    super(opts);
    this.el=null;
    this._adopted=false;
  }

  /** 루트 요소를 만든다. 하위가 덮어쓴다. */
  build(){ return document.createElement('div') }

  /** 이미 있는 요소를 루트로 받는다. */
  adopt(el){
    this.el=el;
    this._adopted=true;
    return this;
  }

  mount(host){
    if(!this.el) this.el=this.build();
    if(host&&this.el.parentNode!==host) host.appendChild(this.el);
    this.render();
    return this;
  }

  /** 지금 상태를 그린다. 하위가 덮어쓴다. */
  render(){}

  dispose(){
    if(this.disposed) return;
    super.dispose();
    if(!this._adopted&&this.el&&this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
