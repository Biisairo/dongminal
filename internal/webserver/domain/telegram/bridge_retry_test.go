package telegram

import (
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ATTIC_FIX_SRS TC-ATF-76: 알림 전송이 실패하면 한 번 다시 보낸다 (AT-TG-3).

// waits 는 브리지가 다시 보내기 전에 기다린 시간을 잡는다. 실제로는 자지 않는다.
type waits struct {
	mu sync.Mutex
	d  []time.Duration
}

func (w *waits) sleep(d time.Duration) {
	w.mu.Lock()
	w.d = append(w.d, d)
	w.mu.Unlock()
}

func (r *rig) fakeSleep() *waits {
	w := &waits{}
	r.b.sleep = w.sleep
	return w
}

func (r *rig) failSends(fs ...fakeFail) {
	r.tg.mu.Lock()
	r.tg.sendFails = append(r.tg.sendFails, fs...)
	r.tg.mu.Unlock()
}

func (r *rig) sends() int {
	n := 0
	for _, m := range r.tg.methods() {
		if m == "sendMessage" {
			n++
		}
	}
	return n
}

func tooMany(after int) fakeFail {
	return fakeFail{http.StatusTooManyRequests,
		`{"ok":false,"error_code":429,"description":"Too Many Requests: retry after","parameters":{"retry_after":` + strconv.Itoa(after) + `}}`}
}

var badEntities = fakeFail{http.StatusBadRequest,
	`{"ok":false,"error_code":400,"description":"Bad Request: can't parse entities: Unsupported start tag"}`}

func TestAlarmRetriesAfter429(t *testing.T) {
	r := newRig(t)
	w := r.fakeSleep()
	r.failSends(tooMany(3))
	r.attn(tabA, "done")
	if n := r.sends(); n != 2 {
		t.Fatalf("sendMessage %d 번, want 2", n)
	}
	if !slices.Equal(w.d, []time.Duration{3 * time.Second}) {
		t.Fatalf("기다림 %v, want [3s]", w.d)
	}
	r.sent(t)
	r.b.mu.Lock()
	ids := slices.Clone(r.b.buttons[tabA])
	r.b.mu.Unlock()
	if !slices.Equal(ids, []int64{2}) {
		t.Fatalf("다시 보낸 알림의 버튼을 기억하지 않았다: %v", ids)
	}
}

func TestAlarmRetryAfterIsCapped(t *testing.T) {
	r := newRig(t)
	w := r.fakeSleep()
	r.failSends(tooMany(int(alarmRetryAfterMax/time.Second) + 600))
	r.attn(tabA, "done")
	if !slices.Equal(w.d, []time.Duration{alarmRetryAfterMax}) {
		t.Fatalf("기다림 %v, want [%v]", w.d, alarmRetryAfterMax)
	}
}

func TestAlarmParseErrorResendsPlain(t *testing.T) {
	r := newRig(t)
	w := r.fakeSleep()
	r.failSends(badEntities)
	r.attn(tabA, "done")
	if n := r.sends(); n != 2 {
		t.Fatalf("sendMessage %d 번, want 2", n)
	}
	body, _ := r.tg.last("sendMessage")
	if _, has := body["parse_mode"]; has {
		t.Fatalf("평문 재전송에 parse_mode 가 남았다: %v", body)
	}
	if body["chat_id"] != float64(me) || body["text"] == "" {
		t.Fatalf("재전송 본문이 틀렸다: %v", body)
	}
	// 평문이면 태그·엔티티를 걷어 보낸다 — 걷지 않으면 사용자에게 `<b>` 가 글자로 보인다.
	if text, _ := body["text"].(string); reHTMLTag.MatchString(text) || strings.Contains(text, "&lt;") || strings.Contains(text, "&amp;") {
		t.Fatalf("평문 재전송에 HTML 이 남았다: %q", text)
	}
	if len(w.d) != 0 {
		t.Fatalf("해석 오류에 기다렸다: %v", w.d)
	}
}

// 다시 보내도 실패하면 더 보내지 않는다 — 한 번만 다시 보낸다.
func TestAlarmRetriesOnlyOnce(t *testing.T) {
	r := newRig(t)
	r.fakeSleep()
	r.failSends(tooMany(1), tooMany(1), tooMany(1))
	r.attn(tabA, "done")
	if n := r.sends(); n != 2 {
		t.Fatalf("sendMessage %d 번, want 2", n)
	}
	r.b.mu.Lock()
	_, ok := r.b.buttons[tabA]
	r.b.mu.Unlock()
	if ok {
		t.Fatal("보내지 못한 알림의 버튼을 기억했다")
	}
}

// 기다리는 동안 b.mu 를 쥐지 않는다.
func TestAlarmRetryWaitsWithoutLock(t *testing.T) {
	r := newRig(t)
	locked := true
	r.b.sleep = func(time.Duration) {
		if r.b.mu.TryLock() {
			locked = false
			r.b.mu.Unlock()
		}
	}
	r.failSends(tooMany(1))
	r.attn(tabA, "done")
	if locked {
		t.Fatal("다시 보내려고 기다리는 동안 b.mu 를 쥐었다")
	}
}

// 그 밖의 실패는 backoffFirst 뒤에 같은 것을 다시 보낸다.
func TestAlarmRetriesOtherFailure(t *testing.T) {
	r := newRig(t)
	w := r.fakeSleep()
	r.failSends(fakeFail{http.StatusBadGateway, `{"ok":false,"error_code":502,"description":"Bad Gateway"}`})
	r.attn(tabA, "done")
	if n := r.sends(); n != 2 {
		t.Fatalf("sendMessage %d 번, want 2", n)
	}
	if !slices.Equal(w.d, []time.Duration{backoffFirst}) {
		t.Fatalf("기다림 %v, want [%v]", w.d, backoffFirst)
	}
	r.sent(t)
}
