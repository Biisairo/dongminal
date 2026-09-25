package core

// oid 의 16진 길이다 — object-format 이 sha1 이면 40, sha256 이면 64 다. 한쪽만
// 받으면 다른 형식의 저장소에서 파서가 모든 줄을 버려 오류 없이 빈 결과가 된다.
const (
	oidLenSHA1   = 40
	oidLenSHA256 = 64
)

// IsOid 는 s 가 완전한 oid(40 또는 64자리 16진수)인가다. 짧은 해시는 받지 않는다 —
// 파서에게 그것은 알아보지 못한 줄이라는 신호다.
func IsOid(s string) bool {
	if len(s) != oidLenSHA1 && len(s) != oidLenSHA256 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// IsNullOid 는 s 가 모두 0 인 oid 인가다 — git 이 "아직 커밋되지 않음" 을 그렇게 답한다.
func IsNullOid(s string) bool {
	if !IsOid(s) {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] != '0' {
			return false
		}
	}
	return true
}
