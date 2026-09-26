package browser

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
)

// 4단계 — 탭의 소리를 보고 있는 기기로 (BROWSER_TAB_SRS FR-BRT-91).
//
// 내장 확장이 offscreen 문서에서 `chrome.tabCapture` 로 탭 소리를 받아 WebRTC 로 보낸다.
// 신호는 매니저가 그 문서에서 식을 계산해 주고받는다 — 확장은 페이지에 아무것도 넣지 않는다.

// audioExtKey 는 내장 확장의 공개 키다 — 이것이 확장 ID 를 고정한다. 비밀이 아니다
// (unpacked 확장은 서명하지 않는다).
const audioExtKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1W99YMZx9ePxhLDnskfbnD5Kh4y50n5guiW3+Mn9eMgv3v3/dSZY/aFtEQRT0tJddVaLrp1f6FW7Ex7cZbJdxTU3Mqh9N9RXnVM114uwmqYFKOyGje05VSdnHGaSKul1nrNZ3Fu+Ee7FKAUW2Y+LcXCC+6zAMpozUNmxpCXDBl3+oSZWVEatuDdQ2mbTe1NJNkNdZH/HZkePJbWcIRgQCktRs5zcp9cGQHw4U/0B2H4GW3tBC6stLvUs3MtUa29waMCLJZNJCgv3H7D0tY31bZqfkJQu3v3uxZPm2mgkbavtwdtQdmWEg56lbyPBuJvpxtJHg+fcQHhpzmUsN/SCkQIDAQAB"

// audioExtID 는 audioExtKey 에서 계산한 ID 다 (TC-BRT-82 가 둘을 대조한다).
const audioExtID = "jancmkhjflieipkfflkfnbnmonefgfnl"

// audioExtDir 는 `<Home>/browser/` 아래 확장 폴더다. 기동마다 다시 쓴다.
const audioExtDir = "audio-ext"

// extensionID 는 Chrome 의 규칙이다 — 키 DER 의 SHA-256 앞 16바이트를 a~p 로 적는다.
func extensionID(key string) string {
	der, _ := base64.StdEncoding.DecodeString(key)
	sum := sha256.Sum256(der)
	h := hex.EncodeToString(sum[:16])
	b := make([]byte, len(h))
	for i := 0; i < len(h); i++ {
		n, _ := strconv.ParseUint(h[i:i+1], 16, 8)
		b[i] = 'a' + byte(n)
	}
	return string(b)
}

const audioExtSW = `const ensure = async () => {
  if (await chrome.offscreen.hasDocument()) return;
  try { await chrome.offscreen.createDocument({url: 'off.html', reasons: ['USER_MEDIA'], justification: 'dongminal: tab audio to the viewer'}) } catch (e) {}
};
chrome.runtime.onStartup.addListener(ensure);
chrome.runtime.onInstalled.addListener(ensure);
ensure();
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m.t !== 'streamId') return;
  (async () => {
    const t = (await chrome.debugger.getTargets()).find(x => x.id === m.target);
    if (!t || t.tabId === undefined) throw new Error('no tab for target');
    return await chrome.tabCapture.getMediaStreamId({targetTabId: t.tabId});
  })().then(id => reply({id}), e => reply({err: String((e && e.message) || e)}));
  return true;
});
`

const audioExtOff = `const peers = new Map(), streams = new Map(); let n = 0;
const streamId = (target) => new Promise((res, rej) => chrome.runtime.sendMessage({t: 'streamId', target}, (r) => {
  if (r && r.id) res(r.id); else rej(new Error(r ? r.err : String(chrome.runtime.lastError && chrome.runtime.lastError.message)));
}));
const hold = (target) => {
  let s = streams.get(target);
  if (!s) {
    s = {users: 0, media: streamId(target).then(id => navigator.mediaDevices.getUserMedia({audio: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: id}}}))};
    streams.set(target, s);
    s.media.catch(() => streams.delete(target));
  }
  s.users++;
  return s.media;
};
const release = (target) => {
  const s = streams.get(target); if (!s || --s.users > 0) return;
  streams.delete(target);
  s.media.then(m => m.getTracks().forEach(t => t.stop()), () => {});
};
const gathered = (pc) => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise((r) => {
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') r() });
  setTimeout(r, 5000);
});
window.__dmOffer = async (target) => {
  let media;
  try { media = await hold(target) } catch (e) { release(target); throw e }
  const pc = new RTCPeerConnection();
  for (const tr of media.getAudioTracks()) pc.addTrack(tr, media);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const peer = 'p' + (++n);
  peers.set(peer, {pc, target});
  return {peer, sdp: pc.localDescription.sdp};
};
window.__dmAnswer = async (peer, sdp) => {
  const p = peers.get(peer); if (!p) throw new Error('no such peer');
  await p.pc.setRemoteDescription({type: 'answer', sdp});
  return true;
};
window.__dmStop = (peer) => {
  const p = peers.get(peer); if (!p) return false;
  peers.delete(peer); p.pc.close(); release(p.target);
  return true;
};
`

// installAudioExt 는 내장 확장을 dir 에 쓴다.
func installAudioExt(dir string) error {
	manifest, _ := json.Marshal(map[string]any{
		"manifest_version": 3, "name": "dongminal audio", "version": "1", "key": audioExtKey,
		"permissions": []string{"tabCapture", "offscreen", "debugger"},
		"background":  map[string]string{"service_worker": "sw.js"},
	})
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for name, body := range map[string]string{"manifest.json": string(manifest), "sw.js": audioExtSW,
		"off.html": `<!doctype html><script src="off.js"></script>`, "off.js": audioExtOff} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// loadAudioExt 는 기동 직후 확장을 싣는다. 실패해도 브라우저는 돈다 — 소리만 없다.
func (b *profileBrowser) loadAudioExt(ctx context.Context) {
	dir := filepath.Join(b.m.cfg.Home, dmenv.BrowserDir, audioExtDir)
	if err := installAudioExt(dir); err != nil {
		dmlog.Warnf(nil, "[browser] 소리 확장을 쓰지 못했다: %v", err)
		return
	}
	if _, err := b.cl.Call(ctx, "", "Extensions.loadUnpacked", map[string]any{"path": dir}); err != nil {
		dmlog.Warnf(nil, "[browser] 소리 확장을 싣지 못했다: %v", err)
		return
	}
	b.mu.Lock()
	b.audioExt = true
	b.mu.Unlock()
}

// audioSession 은 확장 offscreen 문서의 세션이다. 문서가 아직 없으면 잠시 기다린다.
func (b *profileBrowser) audioSession(ctx context.Context) (string, error) {
	b.mu.Lock()
	s, on := b.audioSess, b.audioExt
	b.mu.Unlock()
	if !on {
		return "", errors.New("소리를 이 기기로 받으려면 설정 ▸ Browser ▸ 소리를 '이 기기에서 재생' 으로 두고 브라우저를 다시 띄우세요")
	}
	if s != "" {
		return s, nil
	}
	url := "chrome-extension://" + audioExtID + "/off.html"
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
		res, err := b.cl.Call(ctx, "", "Target.getTargets", nil)
		if err != nil {
			return "", err
		}
		var r struct {
			TargetInfos []targetInfo `json:"targetInfos"`
		}
		json.Unmarshal(res, &r)
		for _, ti := range r.TargetInfos {
			if ti.URL != url {
				continue
			}
			res, err := b.cl.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": ti.TargetID, "flatten": true})
			if err != nil {
				return "", err
			}
			var a struct {
				SessionID string `json:"sessionId"`
			}
			json.Unmarshal(res, &a)
			b.mu.Lock()
			b.audioSess = a.SessionID
			b.mu.Unlock()
			return a.SessionID, nil
		}
	}
	return "", errors.New("소리 확장이 준비되지 않았습니다")
}

// audioEval 은 offscreen 문서에서 식을 계산한다. 문서가 사라졌으면 한 번 다시 붙는다.
func (b *profileBrowser) audioEval(ctx context.Context, expr string) (json.RawMessage, error) {
	for try := 0; ; try++ {
		s, err := b.audioSession(ctx)
		if err != nil {
			return nil, err
		}
		res, err := b.cl.Call(ctx, s, "Runtime.evaluate", map[string]any{"expression": expr, "awaitPromise": true, "returnByValue": true})
		if err != nil {
			b.mu.Lock()
			if b.audioSess == s {
				b.audioSess = ""
			}
			b.mu.Unlock()
			if try == 0 {
				continue
			}
			return nil, err
		}
		var r struct {
			Result struct {
				Value json.RawMessage `json:"value"`
			} `json:"result"`
			Exception *struct {
				Exception struct {
					Description string `json:"description"`
				} `json:"exception"`
				Text string `json:"text"`
			} `json:"exceptionDetails"`
		}
		json.Unmarshal(res, &r)
		if r.Exception != nil {
			msg := r.Exception.Exception.Description
			if msg == "" {
				msg = r.Exception.Text
			}
			return nil, errors.New("소리: " + strings.SplitN(msg, "\n", 2)[0])
		}
		return r.Result.Value, nil
	}
}

// audio 는 뷰어의 신호다 — offer 는 {peer, sdp} 를 돌려주고, answer·stop 은 그 peer 에 대한 것이다.
func (pg *page) audio(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Action string `json:"action"`
		Peer   string `json:"peer"`
		SDP    string `json:"sdp"`
	}
	json.Unmarshal(params, &p)
	switch p.Action {
	case "offer":
		if pg.isolated {
			return nil, errors.New("임시 탭(--isolated)의 소리는 이 기기로 보낼 수 없습니다")
		}
		return pg.b.audioEval(ctx, "__dmOffer("+strconv.Quote(pg.target)+")")
	case "answer":
		_, err := pg.b.audioEval(ctx, "__dmAnswer("+strconv.Quote(p.Peer)+", "+strconv.Quote(p.SDP)+")")
		return okResult, err
	case "stop":
		_, err := pg.b.audioEval(ctx, "__dmStop("+strconv.Quote(p.Peer)+")")
		return okResult, err
	}
	return nil, errors.New("audio 의 action 은 offer·answer·stop 입니다")
}
