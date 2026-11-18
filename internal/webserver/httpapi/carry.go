package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/httpreq"
	"dongminal/internal/shared/httpresp"
	"dongminal/internal/webserver/apierr"
)

// carry 는 이사하는 화면의 localStorage 를 새 주소로 넘기는 일회용 보관이다
// (HOT_REBIND_SRS FR-HRB-26). 서버 메모리에만 있다.
const (
	carryTTL       = 60 * time.Second
	carryMax       = 16
	carryBodyLimit = 1 << 20
	carryPrefix    = "/api/server/carry/"
)

type carryItem struct {
	data []byte
	exp  time.Time
}

type carryStore struct {
	mu    sync.Mutex
	items map[string]carryItem
	now   func() time.Time
}

func newCarryStore() *carryStore {
	return &carryStore{items: map[string]carryItem{}, now: time.Now}
}

// sweep 은 지난 것을 지운다. mu 를 쥔 채 부른다.
func (c *carryStore) sweep(now time.Time) {
	for k, it := range c.items {
		if !now.Before(it.exp) {
			delete(c.items, k)
		}
	}
}

// put 은 맡기고 토큰을 준다. 가득 찼거나 토큰을 만들지 못하면 ok=false 다.
func (c *carryStore) put(data []byte) (string, bool) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", false
	}
	token := hex.EncodeToString(raw[:])
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.sweep(now)
	if len(c.items) >= carryMax {
		return "", false
	}
	c.items[token] = carryItem{data: data, exp: now.Add(carryTTL)}
	return token, true
}

// take 는 한 번만 꺼낸다.
func (c *carryStore) take(token string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sweep(c.now())
	it, ok := c.items[token]
	if !ok {
		return nil, false
	}
	delete(c.items, token)
	return it.data, true
}

// apiServerCarryPost 는 `POST /api/server/carry` 다.
func (s *Server) apiServerCarryPost(w http.ResponseWriter, r *http.Request) {
	raw, err := httpreq.Read(w, r, carryBodyLimit)
	if err != nil {
		codeFail(w, httpreq.Status(err), bodyReadCode(err), "read body")
		return
	}
	if !json.Valid(raw) {
		codeFail(w, http.StatusBadRequest, apierr.CodeBadRequest, "body is not json")
		return
	}
	token, ok := s.carry.put(raw)
	if !ok {
		codeFail(w, http.StatusServiceUnavailable, apierr.CodeBusy, "carry full")
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]string{"token": token})
}

// apiServerCarryGet 은 `GET /api/server/carry/<token>` 이다.
func (s *Server) apiServerCarryGet(w http.ResponseWriter, r *http.Request) {
	data, ok := s.carry.take(strings.TrimPrefix(r.URL.Path, carryPrefix))
	if !ok {
		codeFail(w, http.StatusNotFound, apierr.CodeNotFound, "no such carry")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}
