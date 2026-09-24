package lsp

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/webserver/domain/ext"
)

// IdleAfter 는 쓰이지 않은 세션을 정지시키기까지의 시간이다 (FR-LSP-17).
//
// 언어 서버는 큰 저장소에서 수백 MB 를 쓴다. 짧게 두면 잠깐 다른 일을 하고 돌아온
// 사용자가 매번 기동을 기다리고, 길게 두면 쓰지 않는 메모리가 남는다.
const IdleAfter = 20 * time.Minute

// MaxSessions 는 동시에 살아 있는 세션의 상한이다 (FR-LSP-19).
const MaxSessions = 6

// MaxTextBytes 는 요청이 실을 수 있는 파일 텍스트의 상한이다 (FR-LSP-53).
//
// 요청마다 현재 텍스트가 오는 구조이므로(D-3) 이 값이 곧 한 요청의 크기다.
const MaxTextBytes = 8 << 20

// SweepEvery 는 idle 정리의 주기다.
const SweepEvery = 2 * time.Minute

// sessionKey 는 (루트, 서술자, exe키) 다 (FR-LSP-13, REPO_FIX 02 §3A-3).
//
// 서술자가 단위인 것이 규칙이다 — 언어를 단위로 삼으면 TS·JS 가 같은 서버를 두 번
// 띄운다. exe키는 서버 경로 표에 그 서술자의 경로가 있으면 그 경로, 없으면
// "default" 다 — 경로가 바뀌면 옛 세션을 재사용하지 않는다.
func sessionKey(root, descID, exeKey string) string {
	return root + "\x00" + descID + "\x00" + exeKey
}

// FailureTTL 은 실패 기억의 수명이다 (§3A-4) — 터미널에서 설치한 뒤 재시작 없이
// 이 안에 동작해야 한다. EarlyCrash 는 "기동 직후 크래시" 로 세는 시간이다.
const (
	FailureTTL      = 60 * time.Second
	FailureMaxDelay = 60 * time.Second
	EarlyCrash      = 60 * time.Second
)

// failure 는 (루트, 서술자)의 실패 기억이다. exe 가 바뀌면(설치·경로 변경) 무효다.
type failure struct {
	desc string
	exe  string
	err  error
	at   time.Time
	n    int
}

// retryAt 은 at + min(2^(n-1)s, 60s) 다.
func (f *failure) retryAt() time.Time {
	d := FailureMaxDelay
	if f.n <= 6 {
		if b := time.Duration(1<<(f.n-1)) * time.Second; b < d {
			d = b
		}
	}
	return f.at.Add(d)
}

func failKey(root, descID string) string { return root + "\x00" + descID }

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Definition 은 그 자리의 정의들이다 (FR-LSP-21).
func (s *Service) Definition(ctx context.Context, root, path, text string, line, col int) ([]Location, error) {
	sess, err := s.session(root, path)
	if err != nil {
		return nil, err
	}
	if err := checkText(text); err != nil {
		return nil, err
	}
	if err := s.ready(ctx, sess); err != nil {
		return nil, err
	}
	return sess.Definition(ctx, path, text, line, col)
}

// References 는 그 자리의 참조들이다 (FR-LSP-22).
func (s *Service) References(ctx context.Context, root, path, text string, line, col int, includeDecl bool) ([]Location, error) {
	sess, err := s.session(root, path)
	if err != nil {
		return nil, err
	}
	if err := checkText(text); err != nil {
		return nil, err
	}
	if err := s.ready(ctx, sess); err != nil {
		return nil, err
	}
	return sess.References(ctx, path, text, line, col, includeDecl)
}

// Hover 는 그 자리 심볼의 타입·문서다 (FR-LSP-29).
func (s *Service) Hover(ctx context.Context, root, path, text string, line, col int) (string, error) {
	sess, err := s.session(root, path)
	if err != nil {
		return "", err
	}
	if err := checkText(text); err != nil {
		return "", err
	}
	if err := s.ready(ctx, sess); err != nil {
		return "", err
	}
	return sess.Hover(ctx, path, text, line, col)
}

func checkText(text string) error {
	if len(text) > MaxTextBytes {
		return fmt.Errorf("파일이 너무 큽니다 (%d 바이트, 상한 %d)", len(text), MaxTextBytes)
	}
	return nil
}

// ready 는 핸드셰이크를 기다린다. 핸드셰이크가 실패(initialize 오류·시한 초과)했으면
// 그 세션을 맵에서 빼고 정지하고 실패를 기억한다 (§3A-4) — 캐시에 고착되지 않는다.
// 호출자 ctx 로 빠진 것은 실패가 아니다.
func (s *Service) ready(ctx context.Context, sess *Session) error {
	err := sess.waitReady(ctx)
	if err == nil {
		return nil
	}
	if herr := sess.handshakeErr(); herr != nil {
		s.discard(sess, herr)
		return herr
	}
	return err
}

// discard 는 죽은 세션을 맵에서 빼고(그 세션일 때만 — 재기동된 새 세션을 지우지
// 않는다) 정지(회수)한다. 이 세션의 죽음을 처음 보고하는 쪽이면 기억한다.
func (s *Service) discard(sess *Session, cause error) {
	s.mu.Lock()
	if s.sessions[sess.key] == sess {
		delete(s.sessions, sess.key)
	}
	s.mu.Unlock()
	if cause != nil && sess.markDead() {
		s.remember(sess.root, sess.desc, sess.exe, cause)
	}
	sess.Close()
}

// exited 는 통로가 죽은 세션의 뒷정리다 (§3A-4 회수). 기동 후 EarlyCrash 안에 죽은
// 것만 실패로 센다 — 그 뒤의 크래시는 다음 요청이 곧바로 재기동한다.
func (s *Service) exited(sess *Session) {
	var cause error
	if s.now().Sub(sess.started) < EarlyCrash {
		cause = fmt.Errorf("lsp: %s 가 기동 직후 종료됐습니다", sess.srv.ID)
	} else {
		sess.markDead()
	}
	s.discard(sess, cause)
}

// session 은 이 파일을 맡을 세션을 얻는다. 없으면 세우고, 실패는 기억한다.
//
// **사유가 있는 오류만 낸다** (D-9). LSP 는 안 되는 경우가 많고 — 서술자 없음,
// 실행 파일 없음, 기동 실패 — 그 전부가 "아무 일도 일어나지 않음" 으로 보이면
// 사용자는 모두 우리 버그로 읽는다.
func (s *Service) session(root, path string) (*Session, error) {
	if root == "" {
		return nil, fmt.Errorf("루트가 없습니다")
	}
	// FR-LSP-24·49: 루트 밖은 거절한다.
	if !underRoot(root, path) {
		return nil, fmt.Errorf("루트 밖의 경로입니다")
	}
	if s.Ext == nil {
		return nil, fmt.Errorf("플러그인 계층이 배선되지 않았습니다")
	}
	// FR-PRF-70: **캐시를 먼저 본다.** 살아 있는 세션이 있으면 `Resolve` 를 아예
	// 부르지 않는다 — 호버는 커서를 움직일 때마다 온다. 키는 extDesc → 서술자 →
	// 서버 경로 표 조회 한 번으로 만든다 (§3A-3).
	fileExt := filepath.Ext(path)
	if sess := s.cachedSession(root, fileExt); sess != nil {
		return sess, nil
	}
	m, srv, st, ok := s.Ext.Resolve(fileExt, s.locatorOverrides())
	if !ok {
		return nil, fmt.Errorf("%s 는 코드 탐색을 지원하는 언어가 아닙니다", filepath.Ext(path))
	}
	descID := m.ID + "/" + srv.ID
	exe := ""
	if st.Found {
		exe = st.Exe
	}
	s.mu.Lock()
	if s.sessions == nil {
		s.sessions = map[string]*Session{}
	}
	if s.extDesc == nil {
		s.extDesc = map[string]string{}
	}
	s.extDesc[fileExt] = descID
	key := sessionKey(root, descID, s.exeKeyLocked(descID))
	if sess := s.sessions[key]; sess != nil {
		s.mu.Unlock()
		return sess, nil
	}
	// FR-LSP-16·§3A-4: 기억된 실패는 재시도 시각 전까지 되풀이하지 않는다.
	if err := s.recalledLocked(root, descID, exe); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()

	// 못 찾으면 **무엇이 없는지**를 사유로 낸다 (FR-EXT-29 / D-9).
	if !st.Found {
		err := fmt.Errorf("%s 가 없어 코드 탐색을 할 수 없습니다 — %s (설정 ▸ Code)",
			srv.Exe, ext.MissingText(st))
		s.remember(root, descID, "", err)
		return nil, err
	}

	start := s.Start
	if start == nil {
		start = StartProcess
	}
	// FR-LSP-32: 진단은 요청 없이 오므로 세션을 세울 때 통로를 잇는다.
	sess := newSession(root, srv, st.Exe, start, s.OnDiagnostics)
	sess.desc, sess.key, sess.now = descID, key, s.now
	sess.started, sess.lastUse = s.now(), s.now()
	if sess.initErr != nil {
		s.remember(root, descID, exe, sess.initErr)
		sess.Close()
		return nil, sess.initErr
	}

	s.mu.Lock()
	// 그 사이 다른 요청이 세웠으면 그것을 쓴다 — 둘을 살려 두면 프로세스가 샌다.
	if existing := s.sessions[key]; existing != nil {
		s.mu.Unlock()
		sess.Close()
		return existing, nil
	}
	s.sessions[key] = sess
	s.mu.Unlock()
	// §3A-4: 통로가 죽으면 맵에서 빼고 회수한다 — 죽은 세션이 캐시에 남지 않는다.
	sess.watch(func() { s.exited(sess) })

	// FR-LSP-19: 상한을 넘으면 가장 오래 쓰이지 않은 것을 정지한다.
	s.evictOverLimit()
	return sess, nil
}

// cachedSession 은 확장자만으로 살아 있는 세션을 찾는다. 없으면 nil 이고, 그때만
// `Ext.Resolve` 를 지난다 (FR-PRF-70).
func (s *Service) cachedSession(root, fileExt string) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	descID, ok := s.extDesc[fileExt]
	if !ok {
		return nil
	}
	return s.sessions[sessionKey(root, descID, s.exeKeyLocked(descID))]
}

// recalledLocked 는 기억된 실패가 아직 유효하고 재시도 시각 전이면 그 사유다.
// exe 가 달라졌거나(설치·경로) TTL 이 지났으면 기억을 버린다.
func (s *Service) recalledLocked(root, descID, exe string) error {
	k := failKey(root, descID)
	f := s.failed[k]
	if f == nil {
		return nil
	}
	now := s.now()
	if f.exe != exe || now.Sub(f.at) > FailureTTL {
		delete(s.failed, k)
		return nil
	}
	if now.Before(f.retryAt()) {
		return f.err
	}
	return nil
}

// remember 는 (루트, 서술자, exe)의 실패를 기억한다 — 기동·핸드셰이크·시한 초과·
// 기동 직후 크래시가 모두 여기로 온다 (§3A-4). 같은 exe 의 연속 실패는 n 을 올린다.
//
//	이전 동작: 키가 서술자뿐이라 한 루트의 실패가 모든 루트를 막았고, 지워지지 않았으며,
//	          핸드셰이크 실패 세션은 맵에 남아 같은 오류를 되풀이했다
//	새  동작: (루트, 서술자, exe), TTL 60s, 재시도 간격 min(2^(n-1)s, 60s)
//	이유:     설치한 뒤에도 재시작 전까지 영영 안 됐다 (#17, N7)
func (s *Service) remember(root, descID, exe string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed == nil {
		s.failed = map[string]*failure{}
	}
	k := failKey(root, descID)
	n := 1
	if f := s.failed[k]; f != nil && f.exe == exe && s.now().Sub(f.at) <= FailureTTL {
		n = f.n + 1
	}
	s.failed[k] = &failure{desc: descID, exe: exe, err: err, at: s.now(), n: n}
}

// evictOverLimit 은 상한을 넘긴 만큼 가장 오래 쓰이지 않은 세션을 정지시킨다.
func (s *Service) evictOverLimit() {
	limit := s.MaxSessions
	if limit <= 0 {
		limit = MaxSessions
	}
	for {
		s.mu.Lock()
		if len(s.sessions) <= limit {
			s.mu.Unlock()
			return
		}
		var oldKey string
		var oldest *Session
		for k, sess := range s.sessions {
			if oldest == nil || sess.LastUse().Before(oldest.LastUse()) {
				oldKey, oldest = k, sess
			}
		}
		delete(s.sessions, oldKey)
		s.mu.Unlock()
		if oldest != nil {
			oldest.Close()
		}
	}
}

// Sweep 은 쓰이지 않은 세션을 정지시킨다 (FR-LSP-17).
//
// 정지는 포기가 아니다 — 다시 물으면 다시 선다.
func (s *Service) Sweep() {
	after := s.IdleAfter
	if after <= 0 {
		after = IdleAfter
	}
	cut := s.now().Add(-after)
	var stop []*Session
	s.mu.Lock()
	for k, sess := range s.sessions {
		if sess.LastUse().Before(cut) {
			stop = append(stop, sess)
			delete(s.sessions, k)
		}
	}
	s.mu.Unlock()
	for _, sess := range stop {
		sess.Close()
	}
}

// RunSweeper 는 주기적으로 Sweep 한다. 서버 수명과 함께 시작하고 끝난다.
func (s *Service) RunSweeper(ctx context.Context) {
	t := time.NewTicker(SweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Sweep()
		}
	}
}

// Shutdown 은 모든 세션을 정지시킨다 (FR-LSP-18).
func (s *Service) Shutdown() {
	s.mu.Lock()
	all := s.sessions
	s.sessions = map[string]*Session{}
	// 확장자→서술자 표도 함께 버린다 — 세션이 없으면 그 표는 아무것도 가리키지
	// 않고, 남겨 두면 선언이 바뀐 뒤에도 옛 배정을 붙든다 (FR-PRF-70).
	s.extDesc = nil
	// §3A-4: 정지는 실패 기억도 버린다.
	s.failed = nil
	s.mu.Unlock()
	for _, sess := range all {
		sess.Close()
	}
}

// SessionCount 는 지금 살아 있는 세션 수다. 진단과 검사가 읽는다.
func (s *Service) SessionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// underRoot 는 그 경로가 루트 아래인가다.
//
// `..` 를 지나 밖으로 나가는 경로를 막는 것이 요점이다 — `filepath.Clean` 이
// 그것을 펴 준 뒤에 견준다.
func underRoot(root, path string) bool {
	if path == "" {
		return false
	}
	r := filepath.Clean(root)
	p := filepath.Clean(path)
	if p == r {
		return true
	}
	sep := string(filepath.Separator)
	if !strings.HasSuffix(r, sep) {
		r += sep
	}
	return strings.HasPrefix(p, r)
}
