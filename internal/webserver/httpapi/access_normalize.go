package httpapi

import (
	"fmt"

	"net/netip"
	"strings"
)

// 허용 목록 값의 검증·정규화 (ACCESS_ALLOWLIST_SRS FR-ACL-14·18·25). 저장(`save`)과 잠김
// 묻기(`checkSave`)가 같은 함수를 지난다.

// normalizeAccessConfig 는 저장 전의 검증·정규화다. 저장(`setConfig`)과 잠김 묻기
// (`checkSave`)가 같이 부른다 — 묻기가 통과한 값이 저장에서 거절되면 안 된다.
func normalizeAccessConfig(cfg accessConfig) (accessConfig, error) {
	entries := make([]accessEntry, 0, len(cfg.Entries))
	for i, e := range cfg.Entries {
		v := strings.TrimSpace(e.Value)
		if err := validateAccessValue(v); err != nil {
			return accessConfig{}, fmt.Errorf("entries[%d]: %w", i, err)
		}
		e.Value = v
		entries = append(entries, e)
	}
	// FR-ACL-30: 축②도 같은 규약이다 — 하나라도 유효하지 않으면 아무것도 저장하지
	// 않는다. 축①보다 좁게 받으므로(FR-ACL-29) 검증 함수를 따로 쓴다.
	hosts := make([]accessEntry, 0, len(cfg.Hosts))
	for i, e := range cfg.Hosts {
		v, err := normalizeHostAlias(e.Value)
		if err != nil {
			return accessConfig{}, fmt.Errorf("hosts[%d]: %w", i, err)
		}
		e.Value = v
		hosts = append(hosts, e)
	}
	return accessConfig{Enabled: cfg.Enabled, Entries: entries, Hosts: hosts}, nil
}

// validateAccessValue 는 IP 리터럴·CIDR·호스트명 셋 중 하나인지 본다 (FR-ACL-14).
func validateAccessValue(v string) error {
	if v == "" {
		return fmt.Errorf("빈 값")
	}
	if _, err := netip.ParseAddr(v); err == nil {
		return nil
	}
	if _, err := netip.ParsePrefix(v); err == nil {
		return nil
	}
	if isHostname(v) {
		return nil
	}
	return fmt.Errorf("%q 는 IP·CIDR·호스트명 중 어느 것도 아니다", v)
}

// normalizeHostAlias 는 축②의 값 하나를 검증하고 정규화한다 (FR-ACL-28·29·30).
//
// **와일드카드를 받지 않는다.** 축②는 DNS 리바인딩 방어의 화이트리스트이므로,
// 넓힐 수 있는 문법을 UI 에 놓지 않는다 — 받으면 "어디까지 넓은 것을 막을지"
// 라는 판정을 새로 만들어야 하고 그 판정이 곧 다음 구멍의 자리가 된다. 정말
// 필요한 배치의 입구는 `--allowed-host`(`hostAllow.extra`) 로 남아 있다.
//
// IP·CIDR·포트·스킴도 거절이다 — 그것들은 축①(`Entries`)의 어휘다. 축①과 달리
// `.local` 은 유효하다: 여기는 문자열 비교라 DNS 해석이 필요 없다 (FR-ACL-34).
func normalizeHostAlias(raw string) (string, error) {
	v := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw), "."))
	if v == "" {
		return "", fmt.Errorf("빈 값")
	}
	// 와일드카드를 **먼저** 가른다. `isHostname` 도 이것을 거절하지만, 그때의
	// 사유는 "호스트명이 아니다" 라서 사용자가 왜 안 되는지 알 수 없다.
	if strings.ContainsAny(v, "*?") {
		return "", fmt.Errorf("%q — 와일드카드는 쓸 수 없다. 이 컴퓨터가 불리는 이름을 그대로 적는다", raw)
	}
	if !isHostname(v) {
		return "", fmt.Errorf("%q 는 이름이 아니다 — IP·대역·포트·스킴은 위쪽 허용 목록이 담당한다", raw)
	}
	return v, nil
}

// isHostname 은 RFC 1123 라벨 규칙이다.
//
// **마지막 라벨이 숫자뿐이면 호스트명이 아니다.** 이 한 줄이 `10.0.0.300` 같은
// 오타를 잡는다 — 그것은 IP 파싱에 실패하고, 이 규칙이 없으면 호스트명으로
// 저장돼 영원히 해석되지 않는 항목이 된다.
func isHostname(s string) bool {
	if len(s) > 253 {
		return false
	}
	labels := strings.Split(s, ".")
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return false
		}
		for i, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			case r == '-' && i > 0 && i < len(label)-1:
			default:
				return false
			}
		}
	}
	last := labels[len(labels)-1]
	return strings.TrimLeft(last, "0123456789") != ""
}

func isPlainHostname(v string) bool {
	if _, err := netip.ParseAddr(v); err == nil {
		return false
	}
	if _, err := netip.ParsePrefix(v); err == nil {
		return false
	}
	return isHostname(v)
}
