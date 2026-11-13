package platform

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Secrets 는 OS 의 비밀 저장소다 (CLAUDE_ACCOUNTS_SRS FR-CAC-4).
//
// macOS 만 키체인이 있다. 다른 OS 는 Available 이 false 이고, 호출부는 파일 저장으로
// 내려간다 — Claude Code 도 그 OS 들에서는 `.credentials.json` 을 쓴다.
type Secrets interface {
	Available() bool
	// Account 는 Claude Code 가 키체인 항목에 쓰는 계정명이다.
	Account() string
	// Get 은 값을 읽는다. 항목이 없으면 ("", false, nil) 이다.
	Get(service, account string) (string, bool, error)
	Set(service, account, value string) error
	// Delete 는 항목을 지운다. 없으면 성공이다.
	Delete(service, account string) error
}

var ErrSecretsUnavailable = errors.New("비밀 저장소가 없습니다")

type noSecrets struct{}

func (noSecrets) Available() bool                          { return false }
func (noSecrets) Account() string                          { return keychainDefaultAccount }
func (noSecrets) Get(string, string) (string, bool, error) { return "", false, ErrSecretsUnavailable }
func (noSecrets) Set(string, string, string) error         { return ErrSecretsUnavailable }
func (noSecrets) Delete(string, string) error              { return nil }

const (
	keychainSecurityBin    = "/usr/bin/security"
	keychainTimeout        = 5 * time.Second
	keychainNotFound       = 44
	keychainLineMax        = 4032
	keychainDefaultAccount = "claude-code-user"
)

// stdinRunFn 은 명령을 돌려 표준 출력과 종료 코드를 낸다. 실행 자체가 실패하면 err 다.
type stdinRunFn = func(stdin []byte, name string, args ...string) ([]byte, int, error)

// macKeychain 은 `/usr/bin/security` 로 키체인을 다룬다. 값은 argv 에 싣지 않고
// `security -i` 의 표준 입력으로 hex 로 보낸다 (cswap `macos_keychain.py` 와 같은 규약).
type macKeychain struct {
	run  stdinRunFn
	env  envFn
	home func() (string, error)
}

func newMacKeychain() macKeychain {
	return macKeychain{run: runWithStdin, env: os.Getenv, home: os.UserHomeDir}
}

func (macKeychain) Available() bool { return true }

func (k macKeychain) Account() string {
	if u := k.env("USER"); u != "" {
		return u
	}
	if h, err := k.home(); err == nil {
		if b := filepath.Base(h); b != "" && b != "." && b != string(filepath.Separator) {
			return b
		}
	}
	return keychainDefaultAccount
}

func (k macKeychain) Get(service, account string) (string, bool, error) {
	out, code, err := k.run(nil, keychainSecurityBin, "find-generic-password", "-a", account, "-w", "-s", service)
	if err != nil {
		return "", false, fmt.Errorf("keychain read: %w", err)
	}
	switch code {
	case 0:
		return strings.TrimSuffix(string(out), "\n"), true, nil
	case keychainNotFound:
		return "", false, nil
	}
	return "", false, fmt.Errorf("keychain read failed (rc=%d)", code)
}

func keychainQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

func (k macKeychain) Set(service, account, value string) error {
	hv := hex.EncodeToString([]byte(value))
	line := "add-generic-password -U -a " + keychainQuote(account) + " -s " + keychainQuote(service) + " -X " + hv + "\n"
	var code int
	var err error
	if len(line) <= keychainLineMax {
		_, code, err = k.run([]byte(line), keychainSecurityBin, "-i")
	} else {
		_, code, err = k.run(nil, keychainSecurityBin, "add-generic-password", "-U", "-a", account, "-s", service, "-X", hv)
	}
	if err != nil {
		return fmt.Errorf("keychain write: %w", err)
	}
	if code != 0 {
		return fmt.Errorf("keychain write failed (rc=%d)", code)
	}
	return nil
}

func (k macKeychain) Delete(service, account string) error {
	_, code, err := k.run(nil, keychainSecurityBin, "delete-generic-password", "-a", account, "-s", service)
	if err != nil {
		return fmt.Errorf("keychain delete: %w", err)
	}
	if code != 0 && code != keychainNotFound {
		return fmt.Errorf("keychain delete failed (rc=%d)", code)
	}
	return nil
}

// runWithStdin 은 stdinRunFn 의 실제 구현이다. 종료 코드가 0 이 아닌 것은 err 가 아니다.
func runWithStdin(stdin []byte, name string, args ...string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), keychainTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) && ctx.Err() == nil {
		return out.Bytes(), ee.ExitCode(), nil
	}
	if err != nil {
		return nil, -1, err
	}
	return out.Bytes(), 0, nil
}
