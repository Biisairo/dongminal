package httpapi

import (
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/uuid"
	"dongminal/internal/webserver/domain/claudeacct"
	"dongminal/internal/webserver/hub"
)

// claudeAcctWire 는 서버와 Claude 다중 계정 도메인의 이음매다 (CLAUDE_ACCOUNTS_SRS).
type claudeAcctWire struct {
	svc *claudeacct.Service
	eng *claudeacct.Engine
}

// initClaudeAccounts 는 계정 서비스를 세운다. DataDir 이나 사용자 홈이 없으면 세우지 않는다.
func (s *Server) initClaudeAccounts() {
	if s.cfg.DataDir == "" {
		return
	}
	home := s.cfg.ClaudeHome
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			dmlog.Infof(nil, "claude-accounts: 사용자 홈을 알 수 없다: %v — 끈 채로 시작한다", err)
			return
		}
		home = h
	}
	sec := s.cfg.ClaudeSecrets
	if sec == nil {
		sec = platform.Current().Secrets
	}
	dir := filepath.Join(s.cfg.DataDir, dmenv.ClaudeAccountsDir)
	paths := claudeacct.DefaultClaudePaths(home)
	client := claudeacct.Client{Base: s.cfg.ClaudeAPI, TokenBase: s.cfg.ClaudeAPI, UserAgent: claudeUserAgent(s.cfg.Version)}
	s.ca = &claudeAcctWire{svc: &claudeacct.Service{
		Store:  claudeacct.OpenStore(dir),
		Backup: claudeacct.BackupStore{Dir: dir, Sec: sec},
		Live:   claudeacct.LiveStore{Paths: paths, Sec: sec},
		Claude: paths,
		Dir:    dir,
		API:    client,
		Now:    time.Now,
		NewID:  uuid.NewString,
	}}
	s.ca.eng = &claudeacct.Engine{Svc: s.ca.svc, API: client, Now: time.Now, OnChange: s.claudeAccountsChanged}
	if err := s.ca.eng.Load(); err != nil {
		dmlog.Infof(nil, "claude-accounts: 사용량 캐시를 읽지 못했다: %v", err)
	}
}

// StartClaudeAccounts 는 사용량 조회기를 돌리고, stop 이 닫히면 멈춘다. 등록된 계정이 없으면
// 아무 요청도 하지 않는다 (FR-CAC-50).
func (s *Server) StartClaudeAccounts(stop <-chan struct{}) {
	if s.ca == nil {
		return
	}
	go s.ca.eng.Run(stop)
}

func claudeUserAgent(version string) string {
	if version == "" {
		return "dongminal"
	}
	return "dongminal/" + version
}

// claudeAccountsChanged 는 계정 상태가 바뀌었다고 브라우저에 알린다 (FR-CAC-122).
func (s *Server) claudeAccountsChanged() {
	if s.Commands != nil {
		s.Commands.Broadcast(hub.ClaudeAccountsChangedPayload())
	}
}
