package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

const (
	usageFile      = "usage.json"
	usageSchema    = 1
	fetchStagger   = 250 * time.Millisecond
	activeRefreshT = 6 * time.Second
	idleWake       = 5 * time.Minute
)

// 계정 상태 (FR-CAC-56).
const (
	StatusOK                  = "ok"
	StatusTokenExpired        = "token_expired"
	StatusReloginRequired     = "relogin_required"
	StatusKeychainUnavailable = "keychain_unavailable"
	StatusNoCredentials       = "no_credentials"
	StatusRateLimited         = "rate_limited"
	StatusUnavailable         = "unavailable"
)

// ErrTooSoon 은 즉시 조회를 거절한 이유다 (FR-CAC-58). Row 의 다음 가능 시각을 함께 본다.
var ErrTooSoon = errors.New("조금 전에 조회했거나 물러나는 중입니다")

// UsageAPI 는 엔진이 부르는 Anthropic API 다.
type UsageAPI interface {
	UsageRaw(ctx context.Context, token, query string) ([]byte, error)
	Refresh(ctx context.Context, refreshToken string) (TokenResult, error)
	ClaimReset(ctx context.Context, token, org string, body map[string]any) ([]byte, error)
}

// Row 는 계정 하나의 사용량 캐시와 조회 상태다 (FR-CAC-50). 토큰은 없다.
type Row struct {
	LastGood            *Usage `json:"lastGood,omitempty"`
	FetchedAt           int64  `json:"fetchedAt,omitempty"`
	LastAttemptAt       int64  `json:"lastAttemptAt,omitempty"`
	ConsecutiveFailures int    `json:"consecutiveFailures,omitempty"`
	LastError           string `json:"lastError,omitempty"`
	BackoffUntil        int64  `json:"backoffUntil,omitempty"`
	NextPollAt          int64  `json:"nextPollAt,omitempty"`
	PollIntervalS       int64  `json:"pollIntervalS,omitempty"`
	Last429At           int64  `json:"last429At,omitempty"`
	AuthDeadFP          string `json:"authDeadFp,omitempty"`
	LoginExpiresAt      int64  `json:"loginExpiresAt,omitempty"`
	Status              string `json:"status,omitempty"`
	// UsageOK 는 사용량 조회의 성공 수다. 3번에 1번 초기화 상태를 함께 조회한다 (FR-CAC-60).
	UsageOK         int     `json:"usageOk,omitempty"`
	Resets          *Resets `json:"resets,omitempty"`
	ResetsAttemptAt int64   `json:"resetsAttemptAt,omitempty"`
}

func (r Row) dueAt() int64 { return max(r.NextPollAt, r.BackoffUntil) }

// Engine 은 계정별 사용량 조회기다 (묶음 E). Tick 이 기한이 된 계정을 조회한다.
type Engine struct {
	Svc *Service
	API UsageAPI
	Now func() time.Time
	// Jitter 는 [-1, 1] 의 값이다. 비면 무작위다.
	Jitter func() float64
	// LineFor 는 계정의 라인이다. 비면 계정 문턱값, 그것도 없으면 90 이다.
	LineFor func(Account) float64
	// StatusLine 은 계정의 statusLine 값과 보고 시각(unix 초)이다 (FR-CAC-78). 비면 OAuth 값만 쓴다.
	StatusLine func(Account) (Usage, int64, bool)
	// Models 는 헤드룸에 넣을 scoped 창 설정이다 (FR-CAC-31a). 비면 5시간·주간만 본다.
	Models func() []string
	// OnChange 는 행이 바뀐 뒤 불린다.
	OnChange func()
	Stagger  time.Duration

	mu   sync.Mutex
	rows map[string]Row
	// unsettled 는 응답을 받지 못한 티켓 사용의 request_id 다. 키는 계정 id + 티켓 id (FR-CAC-63).
	unsettled map[string]string
	// lastSwitchAt 은 dongminal 이 마지막으로 전환한 시각이다 (FR-CAC-78 의 60초).
	lastSwitchAt int64
	busy         sync.Mutex
	wake         chan struct{}
}

func (e *Engine) path() string { return filepath.Join(e.Svc.Dir, usageFile) }

// Load 는 usage.json 을 읽는다. 없거나 깨졌으면 빈 상태로 시작한다.
func (e *Engine) Load() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rows = map[string]Row{}
	b, err := os.ReadFile(e.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var f struct {
		Accounts map[string]Row `json:"accounts"`
	}
	if json.Unmarshal(b, &f) != nil {
		dmlog.Infof(nil, "claude-accounts: %s 가 깨졌다 — 비우고 시작한다", usageFile)
		return nil
	}
	if f.Accounts != nil {
		e.rows = f.Accounts
	}
	if h, err := ReadHistory(e.Svc.Dir, 1); err == nil && len(h) == 1 {
		e.lastSwitchAt = h[0].At
	}
	return nil
}

// Rows 는 행의 사본이다.
func (e *Engine) Rows() map[string]Row {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]Row, len(e.rows))
	for k, v := range e.rows {
		out[k] = v
	}
	return out
}

func (e *Engine) saveLocked() {
	b, err := json.MarshalIndent(map[string]any{"schemaVersion": usageSchema, "accounts": e.rows}, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(e.Svc.Dir, dirMode); err != nil {
		return
	}
	if err := platform.WriteFileAtomic(e.path(), b, fileMode); err != nil {
		dmlog.Infof(nil, "claude-accounts: %s 를 쓰지 못했다: %v", usageFile, err)
	}
}

func (e *Engine) setRow(id string, r Row) {
	e.mu.Lock()
	e.rows[id] = r
	e.saveLocked()
	e.mu.Unlock()
	if e.OnChange != nil {
		e.OnChange()
	}
}

func (e *Engine) row(id string) Row {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.rows[id]
}

func (e *Engine) jitter() float64 {
	if e.Jitter != nil {
		return e.Jitter()
	}
	return rand.Float64()*2 - 1
}

func (e *Engine) lineFor(a Account) float64 {
	if e.LineFor != nil {
		return e.LineFor(a)
	}
	if a.Threshold != nil {
		return *a.Threshold
	}
	return defaultLinePct
}

// liveIsAccount 는 활성 저장소가 이 계정의 것인가다 — `~/.claude.json` 의 계정을 본다.
// 바깥에서 `/login` 으로 바꿨다면 활성 기록은 낡았다.
func (e *Engine) liveIsAccount(a Account) bool {
	oa, ok, err := ReadOAuthAccount(e.Svc.Claude.GlobalConfig)
	return err == nil && ok && oa.EmailAddress == a.Email && oa.OrganizationUUID == a.OrgUUID
}

// Tick 은 기한이 된 계정을 조회하고 다음에 깰 시각을 돌려준다.
func (e *Engine) Tick(ctx context.Context) time.Time {
	e.busy.Lock()
	defer e.busy.Unlock()
	st, err := e.Svc.Store.Load()
	now := e.Now()
	if err != nil {
		return now.Add(idleWake)
	}
	e.dropRemoved(st)
	first := true
	for _, a := range st.Accounts {
		r := e.row(a.ID)
		if r.AuthDeadFP != "" && !e.deadCleared(a, r) {
			continue
		}
		if e.row(a.ID).dueAt() > e.Now().Unix() {
			continue
		}
		if !first {
			time.Sleep(e.stagger())
		}
		first = false
		e.fetch(ctx, a, a.ID == st.ActiveID)
	}
	return e.nextWake()
}

func (e *Engine) stagger() time.Duration {
	if e.Stagger > 0 {
		return e.Stagger
	}
	return fetchStagger
}

func (e *Engine) dropRemoved(st State) {
	e.mu.Lock()
	defer e.mu.Unlock()
	changed := false
	for id := range e.rows {
		if st.Find(id) < 0 {
			delete(e.rows, id)
			changed = true
		}
	}
	if changed {
		e.saveLocked()
	}
}

// deadCleared 는 영구 실패한 계정의 자격증명이 바뀌었는지 본다 (FR-CAC-54). 바뀌었으면 표식을 지운다.
func (e *Engine) deadCleared(a Account, r Row) bool {
	c, ok, err := e.Svc.Backup.Read(a.ID)
	if err != nil || !ok || c.Fingerprint() == r.AuthDeadFP {
		return false
	}
	r.AuthDeadFP, r.NextPollAt, r.BackoffUntil, r.ConsecutiveFailures = "", 0, 0, 0
	e.setRow(a.ID, r)
	return true
}

func (e *Engine) nextWake() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.Now()
	next := now.Add(idleWake)
	for _, r := range e.rows {
		if r.AuthDeadFP != "" {
			continue
		}
		if t := time.Unix(r.dueAt(), 0); t.Before(next) {
			next = t
		}
	}
	return next
}

// FetchNow 는 사용자의 "새로 고침" 이다 (FR-CAC-58).
func (e *Engine) FetchNow(ctx context.Context, id string) error {
	st, err := e.Svc.Store.Load()
	if err != nil {
		return err
	}
	i := st.Find(id)
	if i < 0 {
		return ErrNotFound
	}
	r := e.row(id)
	now := e.Now().Unix()
	if r.BackoffUntil > now || (r.LastAttemptAt > 0 && now-r.LastAttemptAt < fetchNowMinGapS) {
		return ErrTooSoon
	}
	e.busy.Lock()
	defer e.busy.Unlock()
	e.fetch(ctx, st.Accounts[i], id == st.ActiveID)
	return nil
}

// credFor 는 조회에 쓸 자격증명과, 갱신하면 쓸 곳(활성 저장소인가)이다.
func (e *Engine) credFor(a Account, active bool) (Credential, bool, bool, error) {
	if active && e.liveIsAccount(a) {
		c, ok, err := e.Svc.Live.Read()
		if err == nil && ok && !c.IsEmpty() {
			return c, true, true, nil
		}
	}
	c, ok, err := e.Svc.Backup.Read(a.ID)
	return c, ok && !c.IsEmpty(), false, err
}

func (e *Engine) fetch(ctx context.Context, a Account, active bool) {
	now := e.Now()
	r := e.row(a.ID)
	r.LastAttemptAt = now.Unix()
	e.Svc.ReclaimProfile(a)
	cred, ok, live, err := e.credFor(a, active)
	switch {
	case errors.Is(err, ErrKeychainUnavailable) || (err != nil && !ok):
		e.fail(a.ID, r, StatusKeychainUnavailable, 0, "")
		return
	case !ok:
		r.Status, r.NextPollAt = StatusNoCredentials, now.Unix()+exhaustedS
		e.setRow(a.ID, r)
		return
	}
	r.LoginExpiresAt = cred.RefreshTokenExpiresAt() / 1000
	if cred.expired(now) {
		cred, err = e.refresh(ctx, a, live, false)
		if err != nil {
			e.refreshFailed(a.ID, r, cred, err)
			return
		}
	}
	raw, err := e.API.UsageRaw(ctx, cred.AccessToken(), "")
	var se *HTTPStatusError
	if errors.As(err, &se) && se.Status == 401 {
		cred, err = e.refresh(ctx, a, live, true)
		if err != nil {
			e.refreshFailed(a.ID, r, cred, err)
			return
		}
		raw, err = e.API.UsageRaw(ctx, cred.AccessToken(), "")
	}
	if err != nil {
		status, ra := 0, ""
		if errors.As(err, &se) {
			status, ra = se.Status, se.RetryAfter
		}
		st := StatusUnavailable
		if status == 429 {
			st = StatusRateLimited
		}
		e.fail(a.ID, r, st, status, ra)
		return
	}
	u, err := ParseUsage(raw)
	if err != nil {
		e.fail(a.ID, r, StatusUnavailable, 0, "")
		return
	}
	r.LoginExpiresAt = cred.RefreshTokenExpiresAt() / 1000
	in := planInput{now: now.Unix(), prevInterval: r.PollIntervalS, prev: r.LastGood, next: &u, active: active, line: e.lineFor(a), last429: r.Last429At}
	if in.prevInterval == 0 {
		in.prevInterval = candidateDefaultS
	}
	j := e.jitter()
	r.PollIntervalS = planInterval(in, j)
	r.NextPollAt = planNext(in, j)
	r.LastGood, r.FetchedAt = &u, now.Unix()
	r.ConsecutiveFailures, r.LastError, r.BackoffUntil, r.Status = 0, "", 0, StatusOK
	r.UsageOK++
	if (r.UsageOK-1)%resetsEvery == 0 {
		r.Resets, r.ResetsAttemptAt = e.fetchResets(ctx, cred.AccessToken(), r.Resets), now.Unix()
	}
	e.setRow(a.ID, r)
}

// fetchResets 는 두 프로그램의 상태다. 조회가 실패한 쪽은 직전 값을 둔다 (FR-CAC-60·61).
func (e *Engine) fetchResets(ctx context.Context, token string, prev *Resets) *Resets {
	out := &Resets{FetchedAt: e.Now().Unix()}
	if prev != nil {
		out.Juniper, out.Cedar = prev.Juniper, prev.Cedar
	}
	if raw, err := e.API.UsageRaw(ctx, token, queryJuniper); err == nil {
		out.Juniper = ParseJuniper(raw)
	}
	if raw, err := e.API.UsageRaw(ctx, token, queryCedar); err == nil {
		out.Cedar = ParseCedar(raw)
	}
	return out
}

// usableCred 는 지금 쓸 수 있는 자격증명이다. 만료됐으면 FR-CAC-43 의 규칙으로 갱신한다.
func (e *Engine) usableCred(ctx context.Context, a Account, active bool) (Credential, bool, error) {
	cred, ok, live, err := e.credFor(a, active)
	if err != nil {
		return cred, live, err
	}
	if !ok {
		return cred, live, ErrLiveEmpty
	}
	if cred.expired(e.Now()) {
		cred, err = e.refresh(ctx, a, live, false)
	}
	return cred, live, err
}

// FetchResetsNow 는 계정 줄을 펼칠 때의 상태 조회다 (FR-CAC-65). 60초 안이거나 물러나는 중이면 ErrTooSoon.
func (e *Engine) FetchResetsNow(ctx context.Context, id string) error {
	st, err := e.Svc.Store.Load()
	if err != nil {
		return err
	}
	i := st.Find(id)
	if i < 0 {
		return ErrNotFound
	}
	r := e.row(id)
	now := e.Now().Unix()
	if r.BackoffUntil > now || (r.ResetsAttemptAt > 0 && now-r.ResetsAttemptAt < fetchNowMinGapS) {
		return ErrTooSoon
	}
	e.busy.Lock()
	defer e.busy.Unlock()
	cred, _, err := e.usableCred(ctx, st.Accounts[i], id == st.ActiveID)
	if err != nil {
		return err
	}
	r = e.row(id)
	r.Resets, r.ResetsAttemptAt = e.fetchResets(ctx, cred.AccessToken(), r.Resets), now
	e.setRow(id, r)
	return nil
}

// Claim 은 제한 초기화 하나를 쓴다 (FR-CAC-62·63). 사용자가 확인한 뒤에만 부른다 — 자동으로 부르는 곳은 없다 (D-CAC-4).
// 결과는 오류가 아니라 ClaimResult 로 돌려준다. 인자가 틀리면 ErrInvalid, 계정이 없으면 ErrNotFound 다.
func (e *Engine) Claim(ctx context.Context, id, program, grantID string) (ClaimResult, error) {
	switch {
	case program == ProgramJuniper && grantID == "":
	case program == ProgramCedar && grantIDRe.MatchString(grantID):
	default:
		return ClaimResult{}, fmt.Errorf("%w: 프로그램 %q 와 티켓 %q 가 맞지 않습니다", ErrInvalid, program, grantID)
	}
	st, err := e.Svc.Store.Load()
	if err != nil {
		return ClaimResult{}, err
	}
	i := st.Find(id)
	if i < 0 {
		return ClaimResult{}, ErrNotFound
	}
	a, active := st.Accounts[i], id == st.ActiveID
	e.busy.Lock()
	defer e.busy.Unlock()
	cred, live, err := e.usableCred(ctx, a, active)
	if err != nil {
		return ClaimResult{Result: "auth_error"}, nil
	}
	body := map[string]any{"program": program}
	key := id + "\x00" + grantID
	if program == ProgramCedar {
		e.mu.Lock()
		req := e.unsettled[key]
		e.mu.Unlock()
		if !requestIDRe.MatchString(req) {
			req = e.Svc.NewID()
		}
		body["grant_id"], body["request_id"] = grantID, req
	}
	raw, err := e.API.ClaimReset(ctx, cred.AccessToken(), a.OrgUUID, body)
	var se *HTTPStatusError
	if errors.As(err, &se) && se.Status == 401 {
		if cred, err = e.refresh(ctx, a, live, true); err != nil {
			return ClaimResult{Result: "auth_error"}, nil
		}
		raw, err = e.API.ClaimReset(ctx, cred.AccessToken(), a.OrgUUID, body)
	}
	res := claimResultOf(program, raw, err)
	if program == ProgramCedar {
		e.mu.Lock()
		if e.unsettled == nil {
			e.unsettled = map[string]string{}
		}
		if res.Result == "unconfirmed" {
			e.unsettled[key] = body["request_id"].(string)
		} else {
			delete(e.unsettled, key)
		}
		e.mu.Unlock()
	}
	if res.Result == "reset" {
		now := e.Now().Unix()
		e.fetch(ctx, a, active)
		// 사용량 조회가 이번에 상태도 조회했으면 다시 묻지 않는다.
		if r := e.row(id); r.ResetsAttemptAt != now {
			r.Resets, r.ResetsAttemptAt = e.fetchResets(ctx, cred.AccessToken(), r.Resets), now
			e.setRow(id, r)
		}
	}
	return res, nil
}

func (e *Engine) fail(id string, r Row, status string, httpStatus int, retryAfter string) {
	now := e.Now().Unix()
	r.ConsecutiveFailures++
	r.BackoffUntil = now + backoffSeconds(r.ConsecutiveFailures, httpStatus, retryAfter)
	r.Status = status
	r.LastError = status
	if httpStatus == 429 {
		r.Last429At = now
	}
	e.setRow(id, r)
}

func (e *Engine) refreshFailed(id string, r Row, cred Credential, err error) {
	if errors.Is(err, ErrReloginRequired) {
		r.AuthDeadFP = cred.Fingerprint()
		r.Status = StatusReloginRequired
		r.LastError = StatusReloginRequired
		e.setRow(id, r)
		return
	}
	e.fail(id, r, StatusTokenExpired, 0, "")
}

// refresh 는 FR-CAC-43 의 규칙으로 토큰을 갱신하고 쓴다. 실패하면 갱신 전 자격증명을 돌려준다.
// 락을 잡는 사이 다른 쪽(Claude Code)이 이미 갱신했으면 그것을 쓴다. force 는 401 뒤의 갱신이다.
func (e *Engine) refresh(ctx context.Context, a Account, live, force bool) (Credential, error) {
	if live {
		release, err := lockClaude(e.Svc.Claude, e.Svc.lockTimeout())
		if err != nil {
			return Credential{}, err
		}
		defer release()
		cur, ok, err := e.Svc.Live.Read()
		if err != nil || !ok {
			return cur, ErrLiveEmpty
		}
		if !force && !cur.expired(e.Now()) {
			return cur, nil
		}
		rctx, cancel := context.WithTimeout(ctx, activeRefreshT)
		defer cancel()
		tr, err := e.API.Refresh(rctx, cur.RefreshToken())
		if err != nil {
			return cur, err
		}
		next := cur.WithTokens(tr, e.Now().UnixMilli())
		if err := e.Svc.Live.Write(next); err != nil {
			return cur, err
		}
		if err := e.Svc.Backup.Write(a.ID, next); err != nil {
			dmlog.Infof(nil, "claude-accounts: 활성 계정 백업을 쓰지 못했다: %v", err)
		}
		return next, nil
	}
	if e.Svc.PinnedRunning(a.ID) {
		return e.refreshPinned(ctx, a, force)
	}
	unlock, err := platform.LockFile(e.Svc.consumeLock(a.ID), e.Svc.lockTimeout())
	if err != nil {
		return Credential{}, err
	}
	defer unlock()
	cur, ok, err := e.Svc.Backup.Read(a.ID)
	if err != nil || !ok {
		return cur, ErrLiveEmpty
	}
	if !force && !cur.expired(e.Now()) {
		return cur, nil
	}
	tr, err := e.API.Refresh(ctx, cur.RefreshToken())
	if err != nil {
		return cur, err
	}
	next := cur.WithTokens(tr, e.Now().UnixMilli())
	if err := e.Svc.Backup.Write(a.ID, next); err != nil {
		return cur, err
	}
	return next, nil
}

// refreshPinned 는 고정 실행 중인 계정의 갱신이다. 그 프로필의 Claude 락 아래에서 갱신하고 프로필
// 저장소와 백업 둘 다에 쓴다 (FR-CAC-43 셋째 갈래).
func (e *Engine) refreshPinned(ctx context.Context, a Account, force bool) (Credential, error) {
	pl := e.Svc.ProfileLive(a.ID)
	release, err := lockClaude(pl.Paths, e.Svc.lockTimeout())
	if err != nil {
		return Credential{}, err
	}
	defer release()
	cur, ok, err := pl.Read()
	if err != nil || !ok || cur.IsEmpty() {
		if cur, ok, err = e.Svc.Backup.Read(a.ID); err != nil || !ok {
			return cur, ErrLiveEmpty
		}
	}
	if !force && !cur.expired(e.Now()) {
		return cur, nil
	}
	tr, err := e.API.Refresh(ctx, cur.RefreshToken())
	if err != nil {
		return cur, err
	}
	next := cur.WithTokens(tr, e.Now().UnixMilli())
	if err := pl.Write(next); err != nil {
		return cur, err
	}
	if err := e.Svc.Backup.Write(a.ID, next); err != nil {
		dmlog.Infof(nil, "claude-accounts: 고정 계정 백업을 쓰지 못했다: %v", err)
	}
	return next, nil
}

// Wake 는 기다리던 Run 을 바로 깨운다(계정 추가·전환 뒤).
func (e *Engine) Wake() {
	e.mu.Lock()
	ch := e.wake
	e.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// Run 은 stop 이 닫힐 때까지 조회한다. 등록된 계정이 없으면 아무것도 부르지 않는다 (FR-CAC-50).
func (e *Engine) Run(stop <-chan struct{}) {
	e.mu.Lock()
	e.wake = make(chan struct{}, 1)
	ch := e.wake
	e.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-stop
		cancel()
	}()
	for {
		next := e.Tick(ctx)
		d := time.Until(next)
		if d < time.Second {
			d = time.Second
		}
		t := time.NewTimer(d)
		select {
		case <-stop:
			t.Stop()
			return
		case <-ch:
			t.Stop()
		case <-t.C:
		}
	}
}
