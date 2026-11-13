package claudeacct

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
)

const (
	autoswitchFile   = "autoswitch.json"
	autoswitchSchema = 1

	autoIdleS          = 300
	autoMinS           = 60
	autoExhaustedMaxS  = 600
	autoFreshenBufferS = 600
	autoSpentPct       = 3.0
	autoHorizonRatio   = 2.0
	autoRecoveryS      = 300
)

// 자동 전환 전략 (FR-CAC-70).
const (
	AutoStrategyBest                 = "best"
	AutoStrategyConsumeFirst         = "consume-first"
	AutoStrategyPriorityConsumeFirst = "priority-consume-first"
)

// 자동 전환 상태 (FR-CAC-76).
const (
	AutoOff       = "off"
	AutoOn        = "on"
	AutoUnmanaged = "unmanaged"
	AutoExhausted = "exhausted"
)

// ErrCswapRunning 은 cswap 자동 전환이 돌고 있어 켜지 않았다는 뜻이다 (FR-CAC-75).
var ErrCswapRunning = errors.New("cswap 자동 전환이 돌고 있습니다. 먼저 cswap auto 를 멈추세요")

// AutoSettings 는 autoswitch.json 의 settings 다 (FR-CAC-70).
type AutoSettings struct {
	Enabled         bool     `json:"enabled"`
	Threshold       float64  `json:"threshold"`
	WeeklyThreshold *float64 `json:"weeklyThreshold"`
	IntervalSeconds int      `json:"intervalSeconds"`
	CooldownSeconds int      `json:"cooldownSeconds"`
	HysteresisPct   float64  `json:"hysteresisPct"`
	Strategy        string   `json:"strategy"`
	UnhealthyTicks  int      `json:"unhealthyTicks"`
	Models          []string `json:"models"`
}

// DefaultAutoSettings 는 FR-CAC-70 의 기본값이다.
func DefaultAutoSettings() AutoSettings {
	return AutoSettings{Threshold: 90, IntervalSeconds: 60, CooldownSeconds: 300, HysteresisPct: 10, Strategy: AutoStrategyBest, UnhealthyTicks: 3}
}

func inRange(v, lo, hi float64) bool { return v >= lo && v <= hi }

// Validate 는 FR-CAC-70 의 범위를 본다.
func (s AutoSettings) Validate() error {
	ok := inRange(s.Threshold, thresholdMin, thresholdMax) &&
		(s.WeeklyThreshold == nil || inRange(*s.WeeklyThreshold, thresholdMin, thresholdMax)) &&
		s.IntervalSeconds >= 15 && s.IntervalSeconds <= 3600 &&
		s.CooldownSeconds >= 0 && s.CooldownSeconds <= 86400 &&
		inRange(s.HysteresisPct, 0, 50) &&
		s.UnhealthyTicks >= 1 && s.UnhealthyTicks <= 100
	switch s.Strategy {
	case AutoStrategyBest, AutoStrategyConsumeFirst, AutoStrategyPriorityConsumeFirst:
	default:
		ok = false
	}
	for _, m := range s.Models {
		ok = ok && strings.TrimSpace(m) != ""
	}
	if !ok {
		return ErrInvalid
	}
	return nil
}

// LastSwitch 는 마지막 자동 전환이다. LeftRecoveryAt 은 떠난 계정의 묶는 창 초기화 시각(모르면 0)이다.
type LastSwitch struct {
	At             int64    `json:"at"`
	From           string   `json:"from"`
	To             string   `json:"to"`
	Trigger        string   `json:"trigger"`
	LeftHeadroom   *float64 `json:"leftHeadroom"`
	LeftRecoveryAt int64    `json:"leftRecoveryAt,omitempty"`
}

// AutoState 는 autoswitch.json 의 state 다 (FR-CAC-76).
type AutoState struct {
	LastSwitch  *LastSwitch       `json:"lastSwitch,omitempty"`
	Quarantined map[string]string `json:"quarantined,omitempty"`
	Unhealthy   int               `json:"unhealthy,omitempty"`
	Notified    map[string]int64  `json:"notified,omitempty"`
}

type autoFile struct {
	SchemaVersion int          `json:"schemaVersion"`
	Settings      AutoSettings `json:"settings"`
	State         AutoState    `json:"state"`
}

// AutoStateView 는 API 로 나가는 상태다.
type AutoStateView struct {
	Status      string      `json:"status"`
	LastSwitch  *LastSwitch `json:"lastSwitch,omitempty"`
	Quarantined []string    `json:"quarantined"`
	NextTickAt  int64       `json:"nextTickAt,omitempty"`
}

// AutoView 는 GET·PUT /api/claude-accounts/autoswitch 의 응답이다.
type AutoView struct {
	Settings AutoSettings  `json:"settings"`
	State    AutoStateView `json:"state"`
}

// Auto 는 자동 전환기다 (묶음 G). 꺼져 있어도 Tick 은 알림 판정을 위해 돈다.
type Auto struct {
	Eng    *Engine
	Now    func() time.Time
	Jitter func() float64
	// Procs 는 프로세스 명령줄 목록이다 (FR-CAC-75). 비면 감지하지 않는다.
	Procs    func() ([]string, error)
	Notify   func(Alert)
	OnChange func()

	mu         sync.Mutex
	file       autoFile
	status     string
	nextTickAt int64
	busy       sync.Mutex
	wake       chan struct{}
}

func (a *Auto) path() string { return filepath.Join(a.Eng.Svc.Dir, autoswitchFile) }

// Load 는 autoswitch.json 을 읽는다. 없거나 깨졌으면 기본값이다.
func (a *Auto) Load() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.file = autoFile{SchemaVersion: autoswitchSchema, Settings: DefaultAutoSettings()}
	b, err := os.ReadFile(a.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	f := autoFile{Settings: DefaultAutoSettings()}
	if json.Unmarshal(b, &f) != nil || f.Settings.Validate() != nil {
		dmlog.Infof(nil, "claude-accounts: %s 가 깨졌다 — 기본값으로 시작한다", autoswitchFile)
		return nil
	}
	f.SchemaVersion = autoswitchSchema
	a.file = f
	return nil
}

func (a *Auto) saveLocked() {
	b, err := json.MarshalIndent(a.file, "", "  ")
	if err != nil {
		return
	}
	unlock, err := a.Eng.Svc.Store.Lock()
	if err != nil {
		dmlog.Infof(nil, "claude-accounts: %s 락 실패: %v", autoswitchFile, err)
		return
	}
	defer unlock()
	if err := writeSecretFile(a.path(), b); err != nil {
		dmlog.Infof(nil, "claude-accounts: %s 쓰기 실패: %v", autoswitchFile, err)
	}
}

func (a *Auto) changed() {
	if a.OnChange != nil {
		a.OnChange()
	}
}

func (a *Auto) settings() AutoSettings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.file.Settings
}

// Models 는 헤드룸에 넣을 scoped 창 설정이다. Engine.Models 에 넣는다.
func (a *Auto) Models() []string { return a.settings().Models }

// LineFor 는 계정의 5시간 라인이다. Engine.LineFor 에 넣는다 (FR-CAC-53 의 긴급 간격).
func (a *Auto) LineFor(acc Account) float64 {
	if acc.Threshold != nil {
		return *acc.Threshold
	}
	return a.settings().Threshold
}

// View 는 설정과 상태다.
func (a *Auto) View() AutoView {
	a.mu.Lock()
	defer a.mu.Unlock()
	status := a.status
	if !a.file.Settings.Enabled {
		status = AutoOff
	} else if status == "" || status == AutoOff {
		status = AutoOn
	}
	q := make([]string, 0, len(a.file.State.Quarantined))
	for id := range a.file.State.Quarantined {
		q = append(q, id)
	}
	sort.Strings(q)
	s := a.file.Settings
	s.Models = append([]string(nil), s.Models...)
	if len(s.Models) == 0 {
		s.Models = nil
	}
	return AutoView{Settings: s, State: AutoStateView{Status: status, LastSwitch: a.file.State.LastSwitch, Quarantined: q, NextTickAt: a.nextTickAt}}
}

// Put 은 settings 의 일부 키를 고친다 (FR-CAC-76). null 은 weeklyThreshold·models 를 지운다.
func (a *Auto) Put(raw []byte) (AutoView, error) {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return AutoView{}, ErrInvalid
	}
	next := a.settings()
	next.Models = append([]string(nil), next.Models...)
	for k, v := range m {
		if err := applyAutoKey(&next, k, v); err != nil {
			return AutoView{}, err
		}
	}
	if err := next.Validate(); err != nil {
		return AutoView{}, err
	}
	if next.Enabled && !a.settings().Enabled && a.cswapRunning() {
		return AutoView{}, ErrCswapRunning
	}
	a.mu.Lock()
	if next.Enabled != a.file.Settings.Enabled {
		a.file.State.Unhealthy = 0
	}
	a.file.Settings = next
	a.saveLocked()
	a.mu.Unlock()
	a.Wake()
	a.changed()
	return a.View(), nil
}

func strictUnmarshal(v json.RawMessage, out any) error {
	d := json.NewDecoder(bytes.NewReader(v))
	if d.Decode(out) != nil {
		return ErrInvalid
	}
	return nil
}

func applyAutoKey(s *AutoSettings, k string, v json.RawMessage) error {
	isNull := string(bytes.TrimSpace(v)) == "null"
	switch k {
	case "enabled":
		return strictUnmarshal(v, &s.Enabled)
	case "threshold":
		return strictUnmarshal(v, &s.Threshold)
	case "weeklyThreshold":
		if isNull {
			s.WeeklyThreshold = nil
			return nil
		}
		var f float64
		if err := strictUnmarshal(v, &f); err != nil {
			return err
		}
		s.WeeklyThreshold = &f
		return nil
	case "intervalSeconds":
		return strictUnmarshal(v, &s.IntervalSeconds)
	case "cooldownSeconds":
		return strictUnmarshal(v, &s.CooldownSeconds)
	case "hysteresisPct":
		return strictUnmarshal(v, &s.HysteresisPct)
	case "strategy":
		return strictUnmarshal(v, &s.Strategy)
	case "unhealthyTicks":
		return strictUnmarshal(v, &s.UnhealthyTicks)
	case "models":
		if isNull {
			s.Models = nil
			return nil
		}
		var one string
		if json.Unmarshal(v, &one) == nil {
			if !strings.EqualFold(one, ModelsAll) {
				return ErrInvalid
			}
			s.Models = []string{ModelsAll}
			return nil
		}
		var list []string
		if err := strictUnmarshal(v, &list); err != nil {
			return err
		}
		s.Models = list
		return nil
	}
	return fmt.Errorf("%w: 모르는 키 %q", ErrInvalid, k)
}

func (a *Auto) cswapRunning() bool {
	if a.Procs == nil {
		return false
	}
	lines, err := a.Procs()
	return err == nil && CswapAutoRunning(lines)
}

// CswapAutoRunning 은 명령줄 목록에 `cswap auto` 가 있는지 본다 (FR-CAC-75). `--dry-run` 은 빼다.
func CswapAutoRunning(cmdlines []string) bool {
	for _, line := range cmdlines {
		f := strings.Fields(line)
		for i := 0; i+1 < len(f); i++ {
			base := filepath.Base(f[i])
			prev := ""
			if i > 0 {
				prev = filepath.Base(f[i-1])
			}
			entry := (base == "cswap" || base == "claude-swap") && (i == 0 || strings.HasPrefix(prev, "python"))
			module := f[i] == "claude_swap" && prev == "-m"
			if (entry || module) && f[i+1] == "auto" && !containsArg(f[i+2:], "--dry-run") {
				return true
			}
		}
	}
	return false
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func (a *Auto) jitter() float64 {
	if a.Jitter != nil {
		return a.Jitter()
	}
	return a.Eng.jitter()
}

// Wake 는 기다리던 Run 을 바로 깨운다.
func (a *Auto) Wake() {
	a.mu.Lock()
	ch := a.wake
	a.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// Run 은 stop 이 닫힐 때까지 판단한다 (FR-CAC-73).
func (a *Auto) Run(stop <-chan struct{}) {
	a.mu.Lock()
	a.wake = make(chan struct{}, 1)
	ch := a.wake
	a.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-stop
		cancel()
	}()
	for {
		d := a.Tick(ctx)
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

// tickOutcome 은 한 번의 판단 결과다.
type tickOutcome int

const (
	outNoAction tickOutcome = iota
	outBlocked
	outExhausted
	outIdle
)

// Tick 은 한 번 판단하고 다음 판단까지의 시간을 돌려준다 (FR-CAC-72·73).
func (a *Auto) Tick(ctx context.Context) time.Duration {
	a.busy.Lock()
	defer a.busy.Unlock()
	if a.settings().Enabled && a.cswapRunning() {
		a.mu.Lock()
		a.file.Settings.Enabled = false
		a.saveLocked()
		a.mu.Unlock()
		a.notify(Alert{Kind: AlertAutoswitchStopped})
		a.changed()
	}
	st, err := a.Eng.Svc.Store.Load()
	if err != nil {
		return autoIdleS * time.Second
	}
	a.releaseQuarantine(st)
	s := a.settings()
	status, out, sleepTo := AutoOff, outIdle, int64(0)
	if s.Enabled {
		status, out, sleepTo = a.decide(ctx, st, s)
	}
	a.evaluateAlerts(s)
	d := a.delay(st, s, out, sleepTo)
	a.mu.Lock()
	prev := a.status
	a.status, a.nextTickAt = status, a.Now().Add(d).Unix()
	a.mu.Unlock()
	if prev != status {
		a.changed()
	}
	return d
}

func (a *Auto) delay(st State, s AutoSettings, out tickOutcome, sleepTo int64) time.Duration {
	now := a.Now().Unix()
	switch out {
	case outExhausted:
		d := int64(autoExhaustedMaxS)
		if sleepTo > now {
			d = min(sleepTo-now, autoExhaustedMaxS)
		}
		return time.Duration(d) * time.Second
	case outBlocked, outIdle:
		return time.Duration(max(int64(s.IntervalSeconds), autoIdleS)) * time.Second
	}
	d := float64(s.IntervalSeconds) * (1 + 0.1*a.jitter())
	if r := a.Eng.row(st.ActiveID); r.NextPollAt > now && float64(r.NextPollAt-now) < d {
		d = math.Max(float64(r.NextPollAt-now), autoMinS)
	}
	return time.Duration(d * float64(time.Second))
}

func (a *Auto) notify(al Alert) {
	if a.Notify != nil {
		a.Notify(al)
	}
}

// releaseQuarantine 은 백업 지문이 바뀐 계정의 격리를 푼다 (FR-CAC-74). 지워진 계정도 뺀다.
func (a *Auto) releaseQuarantine(st State) {
	a.mu.Lock()
	q := a.file.State.Quarantined
	a.mu.Unlock()
	if len(q) == 0 {
		return
	}
	drop := map[string]bool{}
	for id, fp := range q {
		c, ok, err := a.Eng.Svc.Backup.Read(id)
		if st.Find(id) < 0 || (err == nil && ok && c.Fingerprint() != fp) {
			drop[id] = true
		}
	}
	if len(drop) == 0 {
		return
	}
	a.mu.Lock()
	for id := range drop {
		delete(a.file.State.Quarantined, id)
	}
	a.saveLocked()
	a.mu.Unlock()
	a.changed()
}

func (a *Auto) quarantine(id string, c Credential) {
	a.mu.Lock()
	if a.file.State.Quarantined == nil {
		a.file.State.Quarantined = map[string]string{}
	}
	a.file.State.Quarantined[id] = c.Fingerprint()
	a.saveLocked()
	a.mu.Unlock()
	a.changed()
}

// acctView 는 판단에 쓰는 계정 하나의 값이다.
type acctView struct {
	acc   Account
	h     float64
	b     binding
	hasB  bool
	known bool
	reset int64 // 주간 창 초기화 (모르면 0)
}

func (a *Auto) view(acc Account, s AutoSettings, models map[string]bool) acctView {
	v := acctView{acc: acc}
	u, ok := a.Eng.decisionUsage(acc)
	if !ok {
		return v
	}
	v.h, v.known = u.Headroom(models), true
	thr, weekly := s.Threshold, s.WeeklyThreshold
	if acc.Threshold != nil {
		thr, weekly = *acc.Threshold, nil
	}
	v.b, v.hasB = bindingOf(u, models, thr, weekly, s.Threshold)
	if u.SevenDay != nil && u.SevenDay.ResetsAt > a.Now().Unix() {
		v.reset = u.SevenDay.ResetsAt
	}
	return v
}

func (v acctView) lh() float64 {
	if v.hasB {
		return v.b.LineHeadroom
	}
	return v.h
}

func (v acctView) over() bool { return v.hasB && v.b.Over }

func (v acctView) recoveryAt(now int64) int64 {
	if v.hasB && v.b.ResetsAt > now {
		return v.b.ResetsAt
	}
	return 0
}

// escalate 는 모든 후보를 다시 조회할 때인가다: 활성 값을 모르거나 어떤 창이 `라인-15` 이상 (FR-CAC-72 2).
func (a *Auto) escalate(acc Account, s AutoSettings, models map[string]bool) bool {
	u, ok := a.Eng.decisionUsage(acc)
	if !ok {
		return true
	}
	thr, weekly := s.Threshold, s.WeeklyThreshold
	if acc.Threshold != nil {
		thr, weekly = *acc.Threshold, nil
	}
	for _, w := range u.labeled(models) {
		line := thr
		if weekly != nil && !w.five {
			line = *weekly
		}
		if w.Pct >= line-escalationMargin {
			return true
		}
	}
	return false
}

// decide 는 켜진 자동 전환의 판단이다 (FR-CAC-72). 상태, 결과, 소진 시 쉴 시각을 돌려준다.
func (a *Auto) decide(ctx context.Context, st State, s AutoSettings) (string, tickOutcome, int64) {
	i := st.Find(st.ActiveID)
	if i < 0 || !a.Eng.liveIsAccount(st.Accounts[i]) {
		return AutoUnmanaged, outIdle, 0
	}
	models := modelSet(s.Models)
	activeAcc := st.Accounts[i]
	if a.escalate(activeAcc, s, models) {
		a.Eng.refreshStale(ctx, st)
	}
	active := a.view(activeAcc, s, models)
	var trigger string
	if active.known {
		a.setUnhealthy(0)
		switch {
		case active.over() && active.h <= 0:
			trigger = TriggerAtLimit
		case active.over():
			trigger = TriggerProactive
		case s.Strategy == AutoStrategyConsumeFirst:
			trigger = TriggerConsumeFirst
		case s.Strategy == AutoStrategyPriorityConsumeFirst:
			trigger = TriggerPriority
		default:
			return AutoOn, outNoAction, 0
		}
	} else {
		n := a.setUnhealthy(-1)
		if n < s.UnhealthyTicks {
			return AutoOn, outNoAction, 0
		}
		trigger = TriggerFailover
	}
	now := a.Now().Unix()
	a.mu.Lock()
	last := a.file.State.LastSwitch
	a.mu.Unlock()
	if trigger != TriggerAtLimit && trigger != TriggerFailover && last != nil && now-last.At < int64(s.CooldownSeconds) {
		return AutoOn, outNoAction, 0
	}
	cands := a.candidates(st, s, models)
	if len(cands) == 0 {
		return AutoOn, outBlocked, 0
	}
	ordered := a.rankWithBar(trigger, s, active, cands, last, now)
	if len(ordered) == 0 {
		exhausted := true
		for _, c := range cands {
			exhausted = exhausted && c.known && c.h <= 0
		}
		if !exhausted || trigger == TriggerConsumeFirst || trigger == TriggerPriority {
			return AutoOn, outBlocked, 0
		}
		return AutoExhausted, outExhausted, a.earliestRecovery(append(cands, active), now)
	}
	for _, c := range ordered {
		if !a.freshen(ctx, c.acc) {
			continue
		}
		res, err := a.Eng.switchTo(ctx, c.acc.ID, trigger, ByAuto)
		if err != nil {
			dmlog.Infof(nil, "claude-accounts: 자동 전환 실패: %v", err)
			continue
		}
		ls := &LastSwitch{At: now, From: res.From, To: res.To, Trigger: trigger, LeftRecoveryAt: active.recoveryAt(now)}
		if active.known {
			h := active.h
			ls.LeftHeadroom = &h
		}
		a.mu.Lock()
		a.file.State.LastSwitch = ls
		a.saveLocked()
		a.mu.Unlock()
		a.notify(Alert{Kind: AlertAutoswitch, From: displayName(activeAcc), To: displayName(c.acc), Trigger: trigger})
		a.Eng.Wake()
		a.changed()
		return AutoOn, outNoAction, 0
	}
	return AutoOn, outBlocked, 0
}

// candidates 는 후보다: 제외·활성·격리·영구 실패·고정 실행 중이 아닌 계정 (FR-CAC-72 5·87).
func (a *Auto) candidates(st State, s AutoSettings, models map[string]bool) []acctView {
	a.mu.Lock()
	quarantined := a.file.State.Quarantined
	a.mu.Unlock()
	var out []acctView
	for _, acc := range st.Accounts {
		if acc.ID == st.ActiveID || acc.Disabled || quarantined[acc.ID] != "" || a.Eng.row(acc.ID).AuthDeadFP != "" || a.Eng.Svc.PinnedRunning(acc.ID) {
			continue
		}
		out = append(out, a.view(acc, s, models))
	}
	return out
}

// setUnhealthy 는 n 이 0 이면 지우고, 음수면 하나 늘린다. 새 값을 돌려준다.
func (a *Auto) setUnhealthy(n int) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	next := n
	if n < 0 {
		next = a.file.State.Unhealthy + 1
	}
	if next != a.file.State.Unhealthy {
		a.file.State.Unhealthy = next
		a.saveLocked()
	}
	return next
}

// freshen 은 10분 안에 만료되는 후보 토큰을 미리 갱신한다. 영구 실패면 격리한다 (FR-CAC-72 7·74).
func (a *Auto) freshen(ctx context.Context, acc Account) bool {
	c, ok, err := a.Eng.Svc.Backup.Read(acc.ID)
	if err != nil || !ok || c.IsEmpty() {
		return false
	}
	if c.ExpiresAt()/1000-a.Now().Unix() > autoFreshenBufferS {
		return true
	}
	if _, err := a.Eng.refresh(ctx, acc, false, true); err != nil {
		if errors.Is(err, ErrReloginRequired) {
			a.quarantine(acc.ID, c)
		}
		return false
	}
	return true
}

func (a *Auto) earliestRecovery(vs []acctView, now int64) int64 {
	var best int64
	for _, v := range vs {
		if r := v.recoveryAt(now); r > 0 && (best == 0 || r < best) {
			best = r
		}
	}
	if best == 0 {
		return 0
	}
	return best + resetSlackS
}

func allAboveMarginMet(cand, active float64) bool {
	return cand >= math.Min(active*autoHorizonRatio, active+autoSpentPct)
}

// rankWithBar 는 되돌아가기 금지를 적용한 순위다 (FR-CAC-72 6).
func (a *Auto) rankWithBar(trigger string, s AutoSettings, active acctView, cands []acctView, last *LastSwitch, now int64) []acctView {
	if s.Strategy == AutoStrategyPriorityConsumeFirst {
		return rankPriority(active, cands)
	}
	barred, recovered := "", false
	if (trigger == TriggerProactive || trigger == TriggerConsumeFirst) && last != nil && last.To == active.acc.ID {
		barred = last.From
		for _, c := range cands {
			if c.acc.ID != barred || !c.known {
				continue
			}
			recovered = (last.LeftHeadroom != nil && c.h >= *last.LeftHeadroom+autoSpentPct) ||
				(last.LeftRecoveryAt > 0 && c.recoveryAt(now) > 0 && c.recoveryAt(now) <= last.LeftRecoveryAt-autoRecoveryS)
			if recovered && active.known && allAboveMarginMet(c.h, active.h) {
				barred = ""
			}
		}
	}
	ranked := rank(trigger, s, active, cands, barred)
	if barred != "" && len(ranked) == 0 && recovered {
		return rank(trigger, s, active, cands, "")
	}
	return ranked
}

type rankKey struct {
	a, b float64
}

// rank 는 cswap `_rank_candidates` 와 같은 순위다.
func rank(trigger string, s AutoSettings, active acctView, cands []acctView, barred string) []acctView {
	consume := s.Strategy == AutoStrategyConsumeFirst
	measured, allOver := 0, true
	for _, c := range cands {
		if c.known {
			measured++
			allOver = allOver && c.over()
		}
	}
	allAbove := measured > 0 && allOver
	if trigger != TriggerAtLimit && trigger != TriggerFailover {
		allAbove = allAbove && active.over()
	}
	type item struct {
		key rankKey
		v   acctView
	}
	var q []item
	for _, c := range cands {
		if !c.known || c.h <= 0 || c.acc.ID == barred {
			continue
		}
		if trigger == TriggerProactive || trigger == TriggerConsumeFirst {
			switch {
			case c.over() && !allAbove:
				continue
			case allAbove:
				if !allAboveMarginMet(c.h, active.h) {
					continue
				}
			case consume:
				if trigger == TriggerConsumeFirst && (c.reset == 0 || active.reset == 0 || c.reset >= active.reset) {
					continue
				}
			case active.known:
				if c.lh()-active.lh() < s.HysteresisPct {
					continue
				}
			}
		}
		var k rankKey
		switch {
		case allAbove:
			k = rankKey{-c.h, orInf(c.b.ResetsAt)}
		case consume:
			k = rankKey{orInf(c.reset), -c.lh()}
		default:
			k = rankKey{-c.lh(), 0}
		}
		q = append(q, item{k, c})
	}
	sort.SliceStable(q, func(i, j int) bool {
		if q[i].key.a != q[j].key.a {
			return q[i].key.a < q[j].key.a
		}
		return q[i].key.b < q[j].key.b
	})
	out := make([]acctView, len(q))
	for i, it := range q {
		out[i] = it.v
	}
	return out
}

func orInf(ts int64) float64 {
	if ts <= 0 {
		return math.Inf(1)
	}
	return float64(ts)
}

// rankPriority 는 `priority-consume-first` 의 순위다. 라인 아래이고 헤드룸이 남은 후보만 본다.
func rankPriority(active acctView, cands []acctView) []acctView {
	ahead := func(c acctView) bool {
		if c.acc.Priority != active.acc.Priority {
			return c.acc.Priority > active.acc.Priority
		}
		return orInf(c.reset) < orInf(active.reset)
	}
	activeReady := active.known && active.h > 0 && !active.over()
	var q []acctView
	for _, c := range cands {
		if !c.known || c.h <= 0 || c.over() || (activeReady && !ahead(c)) {
			continue
		}
		q = append(q, c)
	}
	sort.SliceStable(q, func(i, j int) bool {
		if q[i].acc.Priority != q[j].acc.Priority {
			return q[i].acc.Priority > q[j].acc.Priority
		}
		return orInf(q[i].reset) < orInf(q[j].reset)
	})
	return q
}
