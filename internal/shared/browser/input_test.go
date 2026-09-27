package browser

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// TC-BRT-92 (FR-BRT-98): 이어진 이동은 뒤의 것, 이어진 휠은 합이다. 나머지는 합치지 않는다.
func TestMergeInput(t *testing.T) {
	move := func(x int) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"t":"mouse","type":"mouseMoved","x":%d,"y":1,"button":"none"}`, x))
	}
	wheel := func(dy float64, mods int) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"t":"wheel","x":10,"y":20,"dx":1,"dy":%g,"mods":%d}`, dy, mods))
	}
	press := json.RawMessage(`{"t":"mouse","type":"mousePressed","x":1,"y":1,"button":"left","clickCount":1}`)
	if got, ok := mergeInput(move(1), move(2)); !ok || !bytes.Equal(got, move(2)) {
		t.Fatalf("이동+이동: %s %v", got, ok)
	}
	got, ok := mergeInput(wheel(30, 0), wheel(12.5, 0))
	var w struct {
		DX, DY float64
		X, Y   float64
		Mods   int
	}
	json.Unmarshal(got, &w)
	if !ok || w.DX != 2 || w.DY != 42.5 || w.X != 10 || w.Y != 20 {
		t.Fatalf("휠+휠: %s %v", got, ok)
	}
	for name, pair := range map[string][2]json.RawMessage{
		"수정키가 다른 휠": {wheel(1, 0), wheel(1, 8)},
		"이동+휠":      {move(1), wheel(1, 0)},
		"이동+누름":     {move(1), press},
		"누름+누름":     {press, press},
	} {
		if _, ok := mergeInput(pair[0], pair[1]); ok {
			t.Errorf("%s 를 합쳤다", name)
		}
	}
}
