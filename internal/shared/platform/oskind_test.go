package platform

import (
	"errors"
	"os"
	"testing"
)

// fakeRead 는 경로→내용 표를 읽기 함수로 만든다. 표에 없는 경로는 ErrNotExist 다.
func fakeRead(files map[string]string) func(string) ([]byte, error) {
	return func(p string) ([]byte, error) {
		if s, ok := files[p]; ok {
			return []byte(s), nil
		}
		return nil, os.ErrNotExist
	}
}

func TestLinuxKind(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  OSKind
	}{
		{
			name:  "WSL2 는 osrelease 에 microsoft 를 남긴다",
			files: map[string]string{osReleasePath: "5.15.153.1-microsoft-standard-WSL2\n"},
			want:  WSL,
		},
		{
			name:  "WSL1 은 version 에만 남기기도 한다",
			files: map[string]string{procVersionPath: "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)\n"},
			want:  WSL,
		},
		{
			name:  "대소문자는 판정을 바꾸지 않는다",
			files: map[string]string{osReleasePath: "5.10.0-MICROSOFT-standard\n"},
			want:  WSL,
		},
		{
			name:  "순수 리눅스",
			files: map[string]string{osReleasePath: "6.8.0-45-generic\n", procVersionPath: "Linux version 6.8.0-45-generic (buildd@lcy02)\n"},
			want:  Linux,
		},
		{
			name:  "읽을 수 없으면 추측하지 않는다 — 리눅스다",
			files: nil,
			want:  Linux,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := linuxKind(fakeRead(tc.files)); got != tc.want {
				t.Fatalf("linuxKind = %q, want %q", got, tc.want)
			}
		})
	}
}

// osrelease 를 읽다 권한 오류가 나도 version 으로 넘어가야 한다. 첫 경로의
// 실패가 판정을 끝내면 WSL 을 리눅스로 오판한다.
func TestLinuxKindFallsThroughReadError(t *testing.T) {
	read := func(p string) ([]byte, error) {
		if p == osReleasePath {
			return nil, errors.New("permission denied")
		}
		return []byte("Linux version 5.15.153.1-microsoft-standard-WSL2"), nil
	}
	if got := linuxKind(read); got != WSL {
		t.Fatalf("linuxKind = %q, want %q", got, WSL)
	}
}
