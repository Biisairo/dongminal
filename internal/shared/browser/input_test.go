package browser

import (
	"reflect"
	"testing"
)

// TC-BRT-42: Mac 뷰어 ⌘C → Windows 서버 Ctrl+C. macOS 서버는 편집 명령을 함께 싣는다.
func TestTranslateKey(t *testing.T) {
	cmdC := KeyInput{Type: "keyDown", Key: "c", Code: "KeyC", KeyCode: 67, Mods: ModMeta, ViewerMac: true}
	got := translateKey(cmdC, false)
	if got["modifiers"] != ModCtrl {
		t.Fatalf("⌘ → Ctrl 이 아니다: %v", got["modifiers"])
	}
	if _, ok := got["commands"]; ok {
		t.Fatalf("Windows 서버에 commands 가 실렸다: %v", got)
	}
	if got["type"] != "rawKeyDown" {
		t.Fatalf("Mod 조합은 글자를 넣지 않는다: %v", got["type"])
	}
	// Windows 뷰어 Ctrl+C → macOS 서버 ⌘C + copy.
	ctrlC := KeyInput{Type: "keyDown", Key: "c", Code: "KeyC", KeyCode: 67, Mods: ModCtrl}
	got = translateKey(ctrlC, true)
	if got["modifiers"] != ModMeta {
		t.Fatalf("Ctrl → ⌘ 이 아니다: %v", got["modifiers"])
	}
	if !reflect.DeepEqual(got["commands"], []string{"copy"}) {
		t.Fatalf("commands=%v", got["commands"])
	}
	// ⇧⌘Z → redo.
	got = translateKey(KeyInput{Type: "keyDown", Key: "Z", Code: "KeyZ", KeyCode: 90, Mods: ModMeta | ModShift, ViewerMac: true}, true)
	if !reflect.DeepEqual(got["commands"], []string{"redo"}) {
		t.Fatalf("redo: %v", got["commands"])
	}
	// 같은 OS 끼리는 그대로다.
	got = translateKey(KeyInput{Type: "keyDown", Key: "a", Code: "KeyA", KeyCode: 65, Mods: ModMeta, ViewerMac: true}, true)
	if got["modifiers"] != ModMeta || !reflect.DeepEqual(got["commands"], []string{"selectAll"}) {
		t.Fatalf("mac→mac: %v", got)
	}
	// 글자 키는 text 를 싣고 keyDown 이다.
	got = translateKey(KeyInput{Type: "keyDown", Key: "a", Code: "KeyA", KeyCode: 65}, false)
	if got["type"] != "keyDown" || got["text"] != "a" {
		t.Fatalf("글자: %v", got)
	}
	got = translateKey(KeyInput{Type: "keyDown", Key: "Enter", Code: "Enter", KeyCode: 13}, false)
	if got["text"] != "\r" {
		t.Fatalf("Enter: %v", got)
	}
	got = translateKey(KeyInput{Type: "keyUp", Key: "a", Code: "KeyA", KeyCode: 65}, false)
	if got["type"] != "keyUp" || got["text"] != nil {
		t.Fatalf("keyUp: %v", got)
	}
	// Meta 키 자체도 바뀐다.
	got = translateKey(KeyInput{Type: "keyDown", Key: "Meta", Code: "MetaLeft", KeyCode: 91, Mods: ModMeta, ViewerMac: true}, false)
	if got["key"] != "Control" || got["code"] != "ControlLeft" || got["windowsVirtualKeyCode"] != 17 {
		t.Fatalf("Meta 키: %v", got)
	}
}

// TC-BRT-42: Windows 가상 키코드를 네이티브 키코드로 싣지 않는다 — macOS 에서 Meta(91)는
// Keypad8 로 읽혀 페이지에 "8" 이 들어갔다(실측).
func TestTranslateKeyNoNativeCode(t *testing.T) {
	for _, mac := range []bool{true, false} {
		got := translateKey(KeyInput{Type: "keyDown", Key: "Meta", Code: "MetaLeft", KeyCode: 91, Mods: ModMeta, ViewerMac: true}, mac)
		if _, ok := got["nativeVirtualKeyCode"]; ok {
			t.Fatalf("serverMac=%v: nativeVirtualKeyCode 를 실었다: %v", mac, got)
		}
		if got["windowsVirtualKeyCode"] == nil {
			t.Fatal("windowsVirtualKeyCode 가 없다")
		}
	}
}
