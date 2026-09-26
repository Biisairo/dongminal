package browser

import (
	"errors"
	"strings"
	"unicode"
)

// namedKeys 는 `dmctl browser press` 가 받는 이름 있는 키다 — key · code · keyCode · 넣는 글자.
var namedKeys = map[string]struct {
	code string
	vk   int
	text string
}{
	"Enter": {"Enter", 13, "\r"}, "Tab": {"Tab", 9, ""}, "Escape": {"Escape", 27, ""},
	"Backspace": {"Backspace", 8, ""}, "Delete": {"Delete", 46, ""}, "Space": {"Space", 32, " "},
	"ArrowUp": {"ArrowUp", 38, ""}, "ArrowDown": {"ArrowDown", 40, ""}, "ArrowLeft": {"ArrowLeft", 37, ""},
	"ArrowRight": {"ArrowRight", 39, ""}, "Home": {"Home", 36, ""}, "End": {"End", 35, ""},
	"PageUp": {"PageUp", 33, ""}, "PageDown": {"PageDown", 34, ""}, "Insert": {"Insert", 45, ""},
	"F1": {"F1", 112, ""}, "F2": {"F2", 113, ""}, "F3": {"F3", 114, ""}, "F4": {"F4", 115, ""},
	"F5": {"F5", 116, ""}, "F6": {"F6", 117, ""}, "F7": {"F7", 118, ""}, "F8": {"F8", 119, ""},
	"F9": {"F9", 120, ""}, "F10": {"F10", 121, ""}, "F11": {"F11", 122, ""}, "F12": {"F12", 123, ""},
}

// parsedKey 는 `Control+Shift+A` 한 줄을 푼 것이다.
type parsedKey struct {
	key, code, text string
	vk, mods        int
}

// parseKeyCombo 는 `press` 의 인자를 푼다. 수정키는 Control(Ctrl)·Shift·Alt·Meta(Cmd)·Mod
// (서버 OS 의 편집 키)다.
func parseKeyCombo(s string, serverMac bool) (parsedKey, error) {
	var k parsedKey
	parts := strings.Split(s, "+")
	for _, m := range parts[:len(parts)-1] {
		switch strings.ToLower(m) {
		case "control", "ctrl":
			k.mods |= ModCtrl
		case "shift":
			k.mods |= ModShift
		case "alt", "option":
			k.mods |= ModAlt
		case "meta", "cmd", "command":
			k.mods |= ModMeta
		case "mod":
			if serverMac {
				k.mods |= ModMeta
			} else {
				k.mods |= ModCtrl
			}
		default:
			return k, errors.New("모르는 수정키입니다: " + m)
		}
	}
	name := parts[len(parts)-1]
	if nk, ok := namedKeys[name]; ok {
		k.key, k.code, k.vk, k.text = name, nk.code, nk.vk, nk.text
		if name == "Space" {
			k.key = " "
		}
		return k, nil
	}
	r := []rune(name)
	if len(r) != 1 {
		return k, errors.New("모르는 키입니다: " + name)
	}
	c := r[0]
	k.key, k.text = name, name
	switch {
	case unicode.IsLetter(c) && c < 128:
		up := unicode.ToUpper(c)
		k.code, k.vk = "Key"+string(up), int(up)
	case unicode.IsDigit(c):
		k.code, k.vk = "Digit"+string(c), int(c)
	}
	if k.mods&(ModCtrl|ModMeta) != 0 {
		k.text = ""
	}
	return k, nil
}

// keyEvents 는 키 하나의 누름·뗌 두 이벤트다.
func (k parsedKey) events() []map[string]any {
	down := map[string]any{"type": "rawKeyDown", "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.vk,
		"nativeVirtualKeyCode": k.vk, "modifiers": k.mods}
	if k.text != "" {
		down["type"] = "keyDown"
		down["text"] = k.text
		down["unmodifiedText"] = k.text
	}
	up := map[string]any{"type": "keyUp", "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.vk,
		"nativeVirtualKeyCode": k.vk, "modifiers": k.mods}
	return []map[string]any{down, up}
}
