/**
 * 채팅 글의 마크다운 (ISSUE_TREE_CHAT_SRS FR-CUX-8·15).
 *
 * 원시 HTML 은 글자로 낸다(`html: false`). 그린 HTML 은 DOMPurify 를 지나 조각으로 받고, 링크는 새 창으로 나간다.
 * 코드 블록은 언어를 `data-lang` 에 싣고, highlight.js 가 아는 언어만 칠한다 — 모르는 언어는 색 없이 낸다.
 * 문서 렌더(`doc-render-util.js`)는 인라인 HTML 을 살리고 줄 번호를 다므로 인스턴스를 나눈다.
 *
 * `chat` 화면 묶음이다. markdown-it·DOMPurify(`mdlib`)와 highlight.js(`hljs`)는 needs 로 먼저 실린다.
 */
let chatMD=null;

function chatMdReady(){
  return typeof markdownit!=='undefined'&&typeof DOMPurify!=='undefined';
}

function chatMarkdown(){
  if(chatMD) return chatMD;
  chatMD=markdownit({html:false,linkify:true,breaks:true});
  const esc=chatMD.utils.escapeHtml;
  chatMD.renderer.rules.fence=(tokens,idx)=>{
    const tok=tokens[idx];
    const lang=(tok.info||'').trim().split(/\s+/)[0];
    const known=lang&&typeof hljs!=='undefined'&&hljs.getLanguage(lang);
    const attr=lang?' data-lang="'+esc(lang)+'"':'';
    // hljs 는 자기 출력에서 escape 를 한다.
    const body=known?hljs.highlight(tok.content,{language:lang,ignoreIllegals:true}).value:esc(tok.content);
    return '<pre class="chat-code"'+attr+'><code'+(known?' class="hljs"':'')+'>'+body+'</code></pre>\n';
  };
  return chatMD;
}

function chatMdHtml(text){
  return chatMarkdown().render(String(text||''));
}

function chatMdFragment(text){
  const frag=DOMPurify.sanitize(chatMdHtml(text),{RETURN_DOM_FRAGMENT:true});
  for(const a of frag.querySelectorAll('a[href]')){
    a.setAttribute('target','_blank');
    a.setAttribute('rel','noopener noreferrer');
  }
  return frag;
}
