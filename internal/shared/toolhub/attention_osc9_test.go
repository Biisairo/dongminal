package toolhub

import "testing"

// OSC 9 는 두 규약이 한 번호를 나눠 쓴다 (HOST_PARITY_SRS 묶음 A).
//
//	ConEmu 확장   ESC ] 9 ; <숫자> ; …    — 제어 명령이다. 알림이 아니다
//	iTerm2 알림   ESC ] 9 ; <문장>        — 이것만 알림이다
//
// 종전에는 `9;4`(progress) 하나만 걸러 냈고, 그래서 Windows 프롬프트가 매번
// 내보내는 `9;9;<경로>`(CWD 보고)가 알람이 되었다 — 명령 하나가 끝날 때마다
// 알람이 울렸다 (§2.1).
func TestDetectAttentionSignal_OSC9_ConEmuExtensionsAreNotNotifications(t *testing.T) {
	// V-HPR-1: 첫 필드가 숫자면 확장 명령이다.
	cases := []string{
		"\x1b]9;9;C:\\Users\\foo\a",     // CWD 보고 — 이번 결함의 실제 원인
		"\x1b]9;9;C:\\Users\\foo\x1b\\", // 같은 것, ST 종단
		"\x1b]9;4;1;50\a",               // progress (종전에도 걸러졌다)
		"\x1b]9;4\a",
		"\x1b]9;1\a",     // ConEmu ping
		"\x1b]9;12\a",    // ConEmu active
		"\x1b]9;5\a",     // ConEmu wait-for-key
		"\x1b]9;7;cmd\a", // ConEmu run
	}
	for _, c := range cases {
		if sig, _ := DetectAttentionSignal([]byte(c), false, AttnMaxCarry); sig {
			t.Errorf("ConEmu 확장은 알림이 아니다: %q", c)
		}
	}
}

func TestDetectAttentionSignal_OSC9_TextIsStillNotification(t *testing.T) {
	// V-HPR-1: 첫 필드가 숫자가 아니면 iTerm2 알림이다.
	cases := []string{
		"\x1b]9;build done\a",
		"\x1b]9;빌드 끝\a",
		"\x1b]9;42 files changed\a", // 숫자로 **시작**할 뿐 숫자만은 아니다
		"\x1b]9\a",                  // 본문 없는 OSC 9 — 확장 명령이 아니다
	}
	for _, c := range cases {
		if sig, _ := DetectAttentionSignal([]byte(c), false, AttnMaxCarry); !sig {
			t.Errorf("iTerm2 형식 알림이어야 한다: %q", c)
		}
	}
}

func TestDetectAttentionSignal_OtherIDsUnchanged(t *testing.T) {
	// V-HPR-3: 이 변경으로 99·777 의 판정은 바뀌지 않는다.
	if sig, _ := DetectAttentionSignal([]byte("\x1b]99;;message\x1b\\"), false, AttnMaxCarry); !sig {
		t.Error("OSC 99 는 알림이다")
	}
	if sig, _ := DetectAttentionSignal([]byte("\x1b]777;notify;T;B\a"), false, AttnMaxCarry); !sig {
		t.Error("OSC 777;notify 는 알림이다")
	}
	if sig, _ := DetectAttentionSignal([]byte("\x1b]777;Cwd;/home/x\a"), false, AttnMaxCarry); sig {
		t.Error("OSC 777;Cwd 는 알림이 아니다")
	}
	if sig, _ := DetectAttentionSignal([]byte("\x1b]0;title\a"), false, AttnMaxCarry); sig {
		t.Error("OSC 0 은 알림이 아니다")
	}
}
