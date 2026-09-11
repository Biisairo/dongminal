package httpapi

import (
	"html"
	"net/http"
	"strings"
)

// 막힌 출발지에게 보이는 화면 (ACCESS_DENIED_PAGE_SRS).
//
// 접수한 말: *"ip 맞지않아 막힐 때 보여지는 페이지 만들어줘. 로딩페이지랑 비슷하게
// 톤앤매너 맞춰서. 여기에는 막힌 본인의 ip, 그리고 해당 서버 소유자에게 문의하라는
// 내용이 있어야해."*
//
// **자족적이어야 한다.** 막힌 출발지는 CSS 도 JS 도 받지 못한다 — 정적 자산이 같은
// 게이트를 지나기 때문이다 (FR-ACL-11). 바깥 자산을 하나라도 참조하면 그 화면은
// 영영 맨몸으로 뜬다. 그래서 스타일은 인라인이고 로고는 인라인 SVG 다.
//
// **목록은 싣지 않는다** (FR-ACL-8). 보이는 것은 **요청자 자신의 IP** 뿐이며, 그것은
// 그가 이미 아는 값이다 — 모르면 무엇을 알려 줘야 하는지조차 모른다.

// wantsDeniedPage 는 이 요청이 **문서**인가다.
//
// API 클라이언트에 HTML 을 주면 그쪽의 오류 처리가 그것을 파싱하려 들고, 그때
// 사유가 "JSON 이 아니다" 로 바뀐다 — 진짜 사유가 화면 뒤로 숨는다.
func wantsDeniedPage(r *http.Request) bool {
	// WebSocket 은 문서가 아니다. `Upgrade` 가 붙으면 무조건 평문이다.
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Mode"), "websocket") {
		return false
	}
	// 브라우저의 주소창 이동은 이것을 붙인다. 가장 곧은 근거다.
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Mode"), "navigate") {
		return true
	}
	// 그것이 없는 판(옛 브라우저·curl)에서는 Accept 를 본다.
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// writeDeniedPage 는 화면을 낸다. 상태는 그대로 403 이다 — 화면이 바뀐다고 뜻이
// 바뀌지는 않는다.
func writeDeniedPage(w http.ResponseWriter, ip string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	// 이 응답만 정책 없이 나가면 그 자리가 예외가 된다. 인라인 스크립트가 없으므로
	// 해시도 필요 없다 — `script-src 'self'` 그대로다.
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; "+cspRest)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(deniedPageHTML(ip)))
}

// deniedPageHTML 은 부트 화면의 톤을 그대로 딛는다 — 같은 바탕색·같은 로고·같은
// 여백 리듬이다 (`web/index.html` 의 `#boot`, `web/style.css:1292~`).
//
// 다른 것은 하나다: **흐르는 진행 바가 없다.** 이 화면은 기다리는 화면이 아니다.
func deniedPageHTML(ip string) string {
	shown := ip
	if strings.TrimSpace(shown) == "" {
		shown = "(알 수 없음)"
	}
	return `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>접근 차단됨 — Dongminal</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{
    display:flex;align-items:center;justify-content:center;padding:24px;
    /* 붉은 기운은 **넓고 옅게** 깐다. 하드한 경고줄 대신 이것이 "무언가 잘못됐다"
       를 먼저 말한다 — 부트 화면의 초록 발광과 같은 문법이고 색만 다르다. */
    background:radial-gradient(46% 38% at 50% 22%,rgba(247,118,142,.10),transparent 72%),#1a1b26;
    color:#a9b1d6;
    font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  .card{
    width:min(94vw,392px);
    padding:34px 30px 26px;text-align:center;
    background:linear-gradient(180deg,rgba(247,118,142,.045),transparent 38%),#16161e;
    border:1px solid #232637;border-radius:16px;
    box-shadow:0 24px 60px rgba(0,0,0,.5);
  }
  /* 아이콘은 **원 안에** 둔다. 맨 글리프는 장식으로 읽히고, 원은 상태로 읽힌다. */
  .mark{
    width:56px;height:56px;margin:0 auto;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    background:rgba(247,118,142,.10);
    box-shadow:inset 0 0 0 1px rgba(247,118,142,.28),0 6px 20px rgba(247,118,142,.10);
  }
  .pill{
    display:inline-block;margin-top:18px;padding:4px 11px;border-radius:999px;
    background:rgba(247,118,142,.11);color:#f7768e;
    font-size:10.5px;font-weight:700;letter-spacing:.14em;
  }
  h1{margin:13px 0 0;font-size:20px;line-height:1.3;color:#c0caf5;font-weight:600;letter-spacing:-.01em}
  .sub{margin-top:9px;font-size:12.5px;color:#565f89}
  .ipwrap{margin-top:24px;text-align:left}
  .label{font-size:10.5px;letter-spacing:.13em;color:#565f89;font-weight:600}
  /* 한 번의 클릭으로 통째로 잡히게 한다 — 소유자에게 알리려면 복사해야 하고,
     이 화면에는 스크립트가 없어 복사 버튼을 둘 수 없다. */
  .ip{
    margin-top:8px;padding:13px 14px;border-radius:9px;
    background:#1a1b26;border:1px solid #232637;
    color:#c0caf5;font-size:15px;letter-spacing:.01em;
    user-select:all;word-break:break-all;
    font-family:'Menlo','Monaco','Consolas','Liberation Mono',monospace;
  }
  .hint{margin-top:7px;font-size:10.5px;color:#414868;letter-spacing:.01em}
  .how{margin-top:22px;font-size:12.5px;line-height:1.7;color:#8b93b8}
  .how b{color:#c0caf5;font-weight:600}
  .how .sec{display:block;margin-top:7px;font-size:11.5px;color:#565f89}
  .brand{
    margin-top:28px;display:flex;align-items:center;justify-content:center;gap:7px;
    color:#39405c;font-size:10px;letter-spacing:.18em;font-weight:600;opacity:.9;
  }
</style>
<div class="card">
  <div class="mark">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="#f7768e" stroke-width="1.7"/>
      <path d="M6.1 6.1 17.9 17.9" stroke="#f7768e" stroke-width="1.7" stroke-linecap="round"/>
    </svg>
  </div>
  <div class="pill">ACCESS DENIED</div>
  <h1>접근이 차단되었습니다</h1>
  <div class="sub">403 Forbidden · 허용된 주소에서만 들어올 수 있습니다</div>

  <div class="ipwrap">
    <div class="label">차단된 당신의 주소</div>
    <div class="ip">` + html.EscapeString(shown) + `</div>
    <div class="hint">클릭하면 주소 전체가 선택됩니다</div>
  </div>

  <div class="how">
    위 주소를 <b>이 서버의 소유자</b>에게 알리고 허용을 요청하세요.
    <span class="sec">소유자는 설정 ▸ Access 에서 그 주소를 더할 수 있습니다.</span>
  </div>

  <div class="brand">
    <svg width="13" height="13" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#2c4b39"/>
      <path d="M16.5 13 H34 A17 17 0 0 1 51 32 A17 17 0 0 1 34 51 H16.5 A3.5 3.5 0 0 1 13 47.5 V16.5 A3.5 3.5 0 0 1 16.5 13 Z" fill="none" stroke="#0d1712" stroke-width="7.5"/>
      <path d="M24 26.5 L29.5 32 L24 37.5" fill="none" stroke="#0d1712" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    DONGMINAL
  </div>
</div>
`
}
