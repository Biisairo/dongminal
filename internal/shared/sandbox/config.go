package sandbox

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Config 는 정의 파일의 내용이다 (FR-SBX-4).
//
// 화면이 이 형태로 읽고 써야 사용자가 파일을 손으로 고치지 않는다 —
// 마운트는 손으로 적기에 실수하기 쉬운 값이다.
type Config struct {
	Mounts []Mount    `json:"mounts,omitempty"`
	Dev    *DevConfig `json:"dev,omitempty"`

	// home 은 Encode 에서 `~` 를 되돌리는 데 쓴다. 사용자가 적은 `~/.ssh` 가
	// 저장 한 번에 절대 경로로 굳으면 그 설정 파일을 다른 계정에서 쓸 수 없다.
	home string
}

type DevConfig struct {
	Image string   `json:"image"`
	Ports []string `json:"ports,omitempty"`
}

// ParseConfig 는 정의 파일의 내용을 읽는다. 저장 전 검증도 이 함수가 한다 —
// 화면이 보낸 것과 파일에서 읽은 것이 같은 문을 지나야 규칙이 갈리지 않는다.
func ParseConfig(blob []byte, home func() (string, error)) (Config, error) {
	cfg := Config{}
	if h, err := home(); err == nil {
		cfg.home = h
	}
	if len(strings.TrimSpace(string(blob))) == 0 {
		return cfg, nil
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(blob, &raw); err != nil {
		return Config{}, fmt.Errorf("샌드박스 정의를 해석할 수 없습니다: %w", err)
	}

	for name, body := range raw {
		switch name {
		case "mounts":
			var items []any
			if err := json.Unmarshal(body, &items); err != nil {
				return Config{}, fmt.Errorf("mounts 를 해석할 수 없습니다: %w", err)
			}
			for _, it := range items {
				m, err := toMount(it, home)
				if err != nil {
					return Config{}, err
				}
				cfg.Mounts = append(cfg.Mounts, m)
			}
		case ProfileScratch:
			return Config{}, fmt.Errorf("%q 프로파일은 재정의할 수 없습니다 — 유일한 격리 경계이므로 그 정책이 설정으로 바뀌어서는 안 됩니다(마운트는 항목의 \"scratch\" 표식으로 더합니다)", name)
		case ProfileDev:
			var pf profileFile
			if err := json.Unmarshal(body, &pf); err != nil {
				return Config{}, fmt.Errorf("%q 프로파일을 해석할 수 없습니다: %w", name, err)
			}
			if pf.Image == "" {
				return Config{}, fmt.Errorf("%q 프로파일에 이미지가 없습니다 — 이 프로파일의 쓸모는 전적으로 이미지 내용물에 달려 있어 기본값을 둘 수 없습니다 (FR-SBX-3)", name)
			}
			ports, err := normalizePorts(name, pf.Ports)
			if err != nil {
				return Config{}, err
			}
			cfg.Dev = &DevConfig{Image: pf.Image, Ports: ports}
		default:
			return Config{}, fmt.Errorf("알 수 없는 샌드박스 프로파일입니다: %q (%s 만 정의할 수 있습니다)", name, ProfileDev)
		}
	}
	return cfg, nil
}

// Encode 는 정의 파일로 쓸 바이트를 낸다. 홈 아래 경로는 `~` 로 되돌린다.
func (c Config) Encode() ([]byte, error) {
	type mountOut struct {
		Host      string `json:"host"`
		Container string `json:"container"`
		ReadOnly  bool   `json:"readonly,omitempty"`
		Scratch   bool   `json:"scratch,omitempty"`
	}
	out := struct {
		Mounts []mountOut `json:"mounts,omitempty"`
		Dev    *DevConfig `json:"dev,omitempty"`
	}{Dev: c.Dev}
	for _, m := range c.Mounts {
		out.Mounts = append(out.Mounts, mountOut{
			Host: c.shrinkHome(m.Host), Container: m.Container,
			ReadOnly: m.ReadOnly, Scratch: m.Scratch,
		})
	}
	return json.MarshalIndent(out, "", "  ")
}

func (c Config) shrinkHome(p string) string {
	if c.home == "" || !strings.HasPrefix(p, c.home) {
		return p
	}
	rest := strings.TrimPrefix(p, c.home)
	if rest == "" {
		return "~"
	}
	if rest[0] == '/' || rest[0] == '\\' {
		return "~/" + strings.TrimLeft(rest, `/\`)
	}
	return p
}

// Profiles 는 이 정의가 만드는 프로파일들이다.
//
// scratch 는 언제나 있고 그 정책은 코드가 갖는다. 기본 마운트만 항목의 표식에
// 따라 나뉘어 담긴다 (FR-SBX-39a/b).
func (c Config) Profiles() map[string]Profile {
	scratch := Scratch()
	for _, m := range c.Mounts {
		if m.Scratch {
			scratch.BaseMounts = append(scratch.BaseMounts, m)
		}
	}
	out := map[string]Profile{ProfileScratch: scratch}
	if c.Dev != nil {
		out[ProfileDev] = Profile{
			Name: ProfileDev, Image: c.Dev.Image, Network: "bridge",
			Ports: c.Dev.Ports, Workspace: true, Helper: true, BaseMounts: c.Mounts,
		}
	}
	return out
}
