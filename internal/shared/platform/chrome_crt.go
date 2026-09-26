package platform

import (
	"encoding/binary"
	"errors"
)

// Windows 의 C 런타임은 자식의 fd 표를 `STARTUPINFOW.lpReserved2` 로 넘긴다
// (FR-BRT-5). Chrome 은 `--remote-debugging-pipe` 에서 fd 3·4 를 그 표로 찾는다.
// 모양은 MSVCRT 의 것이다 — `int32` 개수 · 개수만큼의 플래그 바이트 · 개수만큼의
// `HANDLE` (정렬 없이 이어 붙인다). libuv 의 `CHILD_STDIO_SIZE` 와 같다.
//
// 인코딩을 태그 없는 파일에 두는 이유는 검증이다 — 이 기기(macOS)에서도 모양을
// 시험한다. 실제 상속은 Windows CI 가 판정한다 (TC-BRT-6).

const (
	crtFOPEN = 0x01
	crtFPIPE = 0x08
	crtFDEV  = 0x40
)

// encodeCRTFDs 는 핸들 목록을 lpReserved2 바이트로 옮긴다. ptrSize 는 HANDLE 의
// 크기다 (64비트 8).
func encodeCRTFDs(handles []uint64, flags []byte, ptrSize int) []byte {
	n := len(handles)
	buf := make([]byte, 4+n+n*ptrSize)
	binary.LittleEndian.PutUint32(buf, uint32(n))
	copy(buf[4:], flags)
	for i, h := range handles {
		off := 4 + n + i*ptrSize
		if ptrSize == 8 {
			binary.LittleEndian.PutUint64(buf[off:], h)
		} else {
			binary.LittleEndian.PutUint32(buf[off:], uint32(h))
		}
	}
	return buf
}

// decodeCRTFDs 는 그 역이다 — 시험의 도우미 자식이 자기 fd 3·4 를 찾는 데 쓴다.
func decodeCRTFDs(buf []byte, ptrSize int) (handles []uint64, flags []byte, err error) {
	if len(buf) < 4 {
		return nil, nil, errors.New("lpReserved2 가 짧다")
	}
	n := int(binary.LittleEndian.Uint32(buf))
	if len(buf) < 4+n+n*ptrSize {
		return nil, nil, errors.New("lpReserved2 가 개수보다 짧다")
	}
	flags = append([]byte(nil), buf[4:4+n]...)
	handles = make([]uint64, n)
	for i := range handles {
		off := 4 + n + i*ptrSize
		if ptrSize == 8 {
			handles[i] = binary.LittleEndian.Uint64(buf[off:])
		} else {
			handles[i] = uint64(binary.LittleEndian.Uint32(buf[off:]))
		}
	}
	return handles, flags, nil
}
