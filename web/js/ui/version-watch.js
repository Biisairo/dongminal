/**
 * Remote Terminal — 새 버전 감지 배너
 *
 * 서버를 재시작해도 열려 있는 페이지는 옛 JS 를 계속 돌린다. WebSocket 만
 * 재연결되고 문서는 그대로이기 때문이다. 실제로 그 때문에 교정을 반영하지 않은
 * 화면으로 세 차례 검증을 했다 — 로드 시점이 32분 전이었다.
 *
 * index.html 의 `core/main.js?v=` 를 주기적으로 비교해, 달라지면 배너를 띄운다.
 * 자동 새로고침은 하지 않는다 — 터미널 세션 중에 화면이 갈리면 곤란하다.
 */
(function(){
  const self=(()=>{
    const el=document.querySelector('script[src*="core/main.js"]');
    const m=el&&(el.getAttribute('src')||'').match(/[?&]v=(\d+)/);
    return m?m[1]:null;
  })();
  if(!self) return;

  let shown=false;

  const show=(v)=>{
    if(shown) return; shown=true;
    const b=document.createElement('div');
    b.id='ver-banner';
    b.innerHTML='<span>새 버전이 있습니다 (v'+v+' · 지금 v'+self+')</span>'+
                '<button type="button">새로고침</button>';
    const st=document.createElement('style');
    st.textContent=
      '#ver-banner{position:fixed;left:8px;right:8px;bottom:calc(var(--m-kb-h) + 12px);z-index:9998;'+
        'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;'+
        'background:var(--sidebar-bg,#16161e);border:1px solid var(--accent,#7aa2f7);'+
        'color:var(--text-bright,#c0caf5);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.5)}'+
      '#ver-banner span{flex:1 1 auto}'+
      '#ver-banner button{flex:0 0 auto;background:var(--accent,#7aa2f7);border:none;border-radius:5px;'+
        'color:#16161e;font:inherit;font-weight:600;padding:6px 10px}';
    document.head.appendChild(st);
    document.body.appendChild(b);
    b.querySelector('button').addEventListener('click',()=>location.reload());
  };

  const check=async()=>{
    if(shown) return;
    try{
      const r=await fetch('/?_v='+Date.now(),{cache:'no-store'});
      if(!r.ok) return;
      const m=(await r.text()).match(/core\/main\.js\?v=(\d+)/);
      if(m && m[1]!==self) show(m[1]);
    }catch{}
  };

  setInterval(check, VERSION_CHECK_MS);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check()});
  setTimeout(check, 3000);
})();
