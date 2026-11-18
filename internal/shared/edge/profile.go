package edge

import (
	"fmt"
	"strconv"
)

// 이름 뒤의 번호 (PROFILE_NAME_SRS FR-PFN-4~6). 번호는 저장하지도 주고받지도 않는다 —
// 각 노드가 지문에서 계산한다.
const (
	tagHexLen = 8
	tagMod    = 10000
)

// Tag 는 지문 앞 8자리(16진수)를 uint32 로 읽고 10000 으로 나눈 나머지를 네 자리로 낸다.
// 지문이 틀렸으면 빈 값이다.
func Tag(fp string) string {
	if len(fp) < tagHexLen {
		return ""
	}
	v, err := strconv.ParseUint(fp[:tagHexLen], 16, 32)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%04d", v%tagMod)
}

// Handle 은 `이름#번호` 다. 번호를 낼 수 없으면 이름만이다.
func Handle(name, fp string) string {
	if t := Tag(fp); t != "" {
		return name + "#" + t
	}
	return name
}
