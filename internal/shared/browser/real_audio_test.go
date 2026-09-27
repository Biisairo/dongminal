package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TC-BRT-81: 시험 페이지의 톤이 뷰어의 WebRTC 트랙에 도착한다. 뷰어는 같은 브라우저의
// 다른 탭이다 — 신호는 매니저를 지나고, 미디어는 두 peer 사이로 간다.
func TestRealAudioViewer(t *testing.T) {
	m, _ := realManager(t)
	m.cfg.Audio = func() string { return AudioViewer }
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><title>tone</title>`)
	}))
	t.Cleanup(site.Close)
	ctx := context.Background()
	for _, tab := range []string{"t", "v"} {
		if err := m.Open(ctx, OpenReq{Tab: tab, URL: site.URL + "/" + tab}); err != nil {
			t.Fatal(err)
		}
		waitEval(t, m, tab, `document.title`, `"tone"`)
	}
	if st := string(evalIn(t, m, "t", `(async()=>{const c=new AudioContext();await c.resume();const o=c.createOscillator();o.connect(c.destination);o.start();return c.state})()`)); st != `"running"` {
		t.Fatalf("시험 톤: %s", st)
	}

	res, err := m.Call(ctx, "audio", map[string]any{"tab": "t", "action": "offer"})
	if err != nil {
		t.Fatal(err)
	}
	var offer struct {
		Peer string `json:"peer"`
		SDP  string `json:"sdp"`
	}
	json.Unmarshal(res, &offer)
	if offer.Peer == "" || !strings.Contains(offer.SDP, "m=audio") {
		t.Fatalf("offer: %s", res)
	}
	// 확장의 offscreen 문서·service worker 는 탭이 아니다 (FR-BRT-31).
	if n := len(m.Tabs()); n != 2 {
		t.Fatalf("탭이 %d 개다: %+v", n, m.Tabs())
	}
	raw := evalIn(t, m, "v", `(async()=>{const pc=new RTCPeerConnection();window.pc=pc;
		pc.ontrack=(e)=>{const a=new Audio();a.srcObject=e.streams[0];a.play();window.sink=a};
		await pc.setRemoteDescription({type:'offer',sdp:`+strconv.Quote(offer.SDP)+`});
		await pc.setLocalDescription(await pc.createAnswer());
		if(pc.iceGatheringState!=='complete') await new Promise(r=>pc.addEventListener('icegatheringstatechange',()=>pc.iceGatheringState==='complete'&&r()));
		return pc.localDescription.sdp})()`)
	var answer string
	json.Unmarshal(raw, &answer)
	if _, err := m.Call(ctx, "audio", map[string]any{"tab": "t", "action": "answer", "peer": offer.Peer, "sdp": answer}); err != nil {
		t.Fatal(err)
	}
	energy := `(async()=>{let e=0;(await pc.getStats()).forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='audio')e=r.totalAudioEnergy||0});return e>0})()`
	end := time.Now().Add(15 * time.Second)
	for string(evalIn(t, m, "v", energy)) != "true" {
		if time.Now().After(end) {
			dbg := evalIn(t, m, "v", `(async()=>{const o=[pc.connectionState,pc.iceConnectionState];(await pc.getStats()).forEach(r=>{if(r.type==='inbound-rtp'||r.type==='candidate-pair')o.push(JSON.stringify(r))});return o.join(' | ')})()`)
			t.Fatalf("뷰어에 소리가 오지 않는다: %s\noffer=%s", dbg, offer.SDP)
		}
		time.Sleep(200 * time.Millisecond)
	}
	if _, err := m.Call(ctx, "audio", map[string]any{"tab": "t", "action": "stop", "peer": offer.Peer}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "v", `['closed','failed','disconnected'].includes(pc.connectionState)||pc.getReceivers().every(r=>r.track.readyState==='ended'||r.track.muted)`, `true`)

	// 한계: 임시 컨텍스트에는 확장이 닿지 않는다 — 오류로 알린다.
	if err := m.Open(ctx, OpenReq{Tab: "i", URL: site.URL + "/i", Isolated: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Call(ctx, "audio", map[string]any{"tab": "i", "action": "offer"}); err == nil {
		t.Fatal("임시 탭의 소리를 받았다")
	}
}

// FR-BRT-91: offscreen 문서가 target 으로 보여도 그 스크립트가 아직 돌지 않았을 수 있다
// (CI 실측: "__dmOffer is not defined" — 거절받은 뷰어는 다시 청하지 않는다). 그 순간을
// 흉내 낸다 — 함수를 잠시 치웠다가 되돌리는 사이에 offer 가 온다.
func TestRealAudioOfferWaitsForScript(t *testing.T) {
	m, _ := realManager(t)
	m.cfg.Audio = func() string { return AudioViewer }
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: "about:blank"}); err != nil {
		t.Fatal(err)
	}
	b := browserOf(m, DefaultProfile)
	if _, err := b.audioEval(ctx, `(window.__dmOfferHeld = window.__dmOffer, delete window.__dmOffer, setTimeout(() => { window.__dmOffer = window.__dmOfferHeld }, 300), true)`); err != nil {
		t.Fatal(err)
	}
	res, err := m.Call(ctx, "audio", map[string]any{"tab": "t", "action": "offer"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res), "m=audio") {
		t.Fatalf("offer: %s", res)
	}
}
