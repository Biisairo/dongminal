/**
 * OpenUrl — 쉘이 띄우려는 URL 을 이 기기에서 연다 (VIEWER_URL_OPEN_SRS).
 *
 * 서버가 "보고 있는 기기가 서버와 다른 컴퓨터" 라고 판정했을 때만 여기까지
 * 온다 (FR-VUO-3). 같은 컴퓨터면 부른 셸이 직접 열고 이 경로는 타지 않는다.
 *
 * **여는 것은 클릭 안에서 해야 한다** (FR-VUO-8). 사용자 제스처 없이 부른
 * `window.open` 은 모든 주요 브라우저가 차단하고, 차단은 조용하다 — 사용자는
 * 아무 일도 일어나지 않은 화면만 본다. 확인 팝업은 그래서 안전 장치이면서
 * 동시에 **기술적 필요**다.
 */
const OpenUrl = {
  // 서버 머신의 자기 주소들. 이 이름들은 뷰어에서 뜻이 달라진다 — 아이패드의
  // localhost 는 아이패드 자신이다.
  LOCAL_HOSTS: ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'],

  /**
   * FR-VUO-10: 서버의 로컬 주소를 **뷰어가 지금 서버에 닿은 host** 로 바꾼다.
   * scheme·포트·경로·쿼리·프래그먼트는 보존한다. 알아볼 수 없는 값은 그대로
   * 흘린다 — 여기서 삼키면 사용자가 왜 안 열렸는지 알 수 없다.
   */
  rewrite(raw, hostname){
    try{
      const u=new URL(raw);
      if(this.LOCAL_HOSTS.indexOf(u.hostname)>=0&&hostname) u.hostname=hostname;
      return u.href;
    }catch(e){ return raw }
  },

  // FR-VUO-18 의 뷰어 쪽 방어. SSE 로 오는 값이므로 서버만 믿지 않는다.
  isOpenable(raw){
    try{
      const p=new URL(raw).protocol;
      return p==='http:'||p==='https:';
    }catch(e){ return false }
  },

  /**
   * 열기 요청 하나를 처리한다. FR-VUO-5 — 이전 확인을 기억하지 않으므로 올
   * 때마다 묻는다.
   */
  handle(raw){
    if(!raw||!this.isOpenable(raw)) return;
    const url=this.rewrite(raw, location.hostname);
    this._ask(url);
  },

  /**
   * FR-VUO-7: 화면 가운데에 선다. 스스로 사라지지 않으며, 무엇이 열릴지 최종
   * 주소로 보인다.
   *
   * 하단 알림(`Toast`)이 아닌 이유는 이것이 **알림이 아니라 질문**이기 때문이다.
   * 답하지 않으면 열기 요청이 사라지는데, 구석에서 스스로 사라지는 요소는
   * 답을 받기 위한 자리가 아니다.
   */
  _ask(url){
    const body=document.createElement('div');
    body.className='openurl-ask';

    const lead=document.createElement('div');
    lead.className='openurl-lead';
    lead.textContent='이 기기의 브라우저로 엽니다.';

    const addr=document.createElement('div');
    addr.className='openurl-addr';
    addr.textContent=url;
    addr.title=url;

    body.appendChild(lead); body.appendChild(addr);

    const m=UIKit.modal({
      title:'여기서 열기',
      cls:'openurl-modal',
      width:'min(520px,90vw)',
      body,
      actions:[
        {label:'취소'},
        // 이 호출은 클릭 핸들러의 동기 실행 안에 있다 (FR-VUO-8). 제스처 밖으로
        // 나가면 브라우저가 조용히 차단한다.
        {label:'열기', kind:'primary', cls:'openurl-go',
         onClick:()=>window.open(url,'_blank')},
      ],
    });
    // 목적 버튼의 포커스는 `UIKit.modal` 이 준다 (FR-PDA-11) — 여기서 찾던
    // 것이 ACL 경고에는 없어서 그 창만 포커스가 비어 있었다.
    document.body.appendChild(m.el);
  },
};
