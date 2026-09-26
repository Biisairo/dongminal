package browser

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"dongminal/internal/shared/cdp"
	"dongminal/internal/shared/uuid"
)

// CDP 프록시 — 외부 도구(Playwright·puppeteer·chrome-devtools-mcp)가 같은 브라우저에
// 붙는다 (FR-BRT-21·22·44). 포트를 열지 않는다(D-BRT-2): 웹 서버의 WS 가 여기로 잇는다.

// EvProxy 는 외부 도구에게 보낼 CDP 메시지다. Info 는 {client, closed?}, Data 는 메시지다.
const EvProxy = "proxy"

type proxyClient struct {
	id   string
	b    *profileBrowser
	p    *cdp.Proxy
	tool string
}

type proxyInfo struct {
	Client string `json:"client"`
	Closed bool   `json:"closed,omitempty"`
}

func (m *Manager) proxyOpen(ctx context.Context, profile, tool string) (string, error) {
	if profile == "" {
		profile = DefaultProfile
	}
	if !profileNameRe.MatchString(profile) {
		return "", ErrBadProfile
	}
	b, err := m.browserFor(ctx, profile)
	if err != nil {
		return "", err
	}
	id := uuid.NewString()
	pc := &proxyClient{id: id, b: b, tool: tool}
	info, _ := json.Marshal(proxyInfo{Client: id})
	p, err := b.mux.OpenProxy(ctx, func(msg []byte) {
		m.emit(Event{Kind: EvProxy, Info: info, Data: msg})
	}, func(targetID string) { b.externalCreated(targetID, tool) })
	if err != nil {
		return "", err
	}
	pc.p = p
	m.mu.Lock()
	if m.proxies == nil {
		m.proxies = map[string]*proxyClient{}
	}
	m.proxies[id] = pc
	m.mu.Unlock()
	return id, nil
}

func (m *Manager) proxyOf(id string) (*proxyClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pc := m.proxies[id]
	if pc == nil {
		return nil, errors.New("그 CDP 연결이 없습니다")
	}
	return pc, nil
}

func (m *Manager) proxyClose(id string) {
	m.mu.Lock()
	pc := m.proxies[id]
	delete(m.proxies, id)
	m.mu.Unlock()
	if pc != nil {
		pc.p.Close()
	}
}

// proxiesGone 은 브라우저가 끝났을 때 그 브라우저의 외부 연결을 닫는다.
func (m *Manager) proxiesGone(b *profileBrowser) {
	m.mu.Lock()
	var gone []string
	for id, pc := range m.proxies {
		if pc.b == b {
			gone = append(gone, id)
			delete(m.proxies, id)
		}
	}
	m.mu.Unlock()
	for _, id := range gone {
		info, _ := json.Marshal(proxyInfo{Client: id, Closed: true})
		m.emit(Event{Kind: EvProxy, Info: info})
	}
}

// version 은 `json/version` 의 재료다 — 그 프로필 브라우저를 띄워서 묻는다.
func (m *Manager) version(ctx context.Context, profile string) (json.RawMessage, error) {
	if profile == "" {
		profile = DefaultProfile
	}
	if !profileNameRe.MatchString(profile) {
		return nil, ErrBadProfile
	}
	b, err := m.browserFor(ctx, profile)
	if err != nil {
		return nil, err
	}
	return b.cl.Call(ctx, "", "Browser.getVersion", nil)
}

// externalCreated 는 외부 도구가 만든 target 이다 — 그 페이지는 탭이 되고, 호출 칸은
// 그 연결의 도구다 (FR-BRT-44).
func (b *profileBrowser) externalCreated(target, tool string) {
	b.mu.Lock()
	b.foreign[target] = tool
	_, waiting := b.unclaimed[target]
	b.mu.Unlock()
	if waiting {
		// 붙은 뒤다 — 기다릴 것 없이 탭으로 만든다.
		time.AfterFunc(0, func() { b.adoptForeign(targetInfo{TargetID: target}) })
	}
}
