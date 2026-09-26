package browser

// 수정키 비트 — CDP `Input.dispatch*Event` 의 `modifiers` 와 같은 값이다.
const (
	ModAlt   = 1
	ModCtrl  = 2
	ModMeta  = 4
	ModShift = 8
)

// KeyInput 은 뷰어가 보낸 키 하나다 (FR-BRT-54). 값은 DOM `KeyboardEvent` 의 것이다.
type KeyInput struct {
	Type      string `json:"type"` // keyDown | keyUp
	Key       string `json:"key"`
	Code      string `json:"code"`
	KeyCode   int    `json:"keyCode"`
	Location  int    `json:"location"`
	Mods      int    `json:"mods"`
	Repeat    bool   `json:"repeat"`
	ViewerMac bool   `json:"mac"`
}

// macEditCommands 는 macOS 서버에서 ⌘ 조합과 함께 실어야 하는 편집 명령이다.
// headless Chrome 은 macOS 에서 ⌘ 단축키를 키 이벤트만으로 처리하지 않는다.
var macEditCommands = map[string]string{"a": "selectAll", "c": "copy", "v": "paste", "x": "cut", "z": "undo"}

// translateKey 는 뷰어의 키를 `Input.dispatchKeyEvent` 의 인자로 바꾼다.
// serverMac 은 서버 OS 의 Mod 가 ⌘ 인가다 (platform.Chrome.ModIsMeta).
//
// 뷰어의 Mod 를 **서버 OS 가 쓰는 쪽**으로 바꾼다 — Mac 뷰어의 ⌘C 는 Windows 서버에서
// Ctrl+C 다. 뷰어의 Mod 는 Mac 이면 ⌘, 아니면 Ctrl 이다.
func translateKey(k KeyInput, serverMac bool) map[string]any {
	viewerMod, serverMod := ModCtrl, ModCtrl
	if k.ViewerMac {
		viewerMod = ModMeta
	}
	if serverMac {
		serverMod = ModMeta
	}
	mods := k.Mods
	key, code, vk := k.Key, k.Code, k.KeyCode
	if viewerMod != serverMod {
		if mods&viewerMod != 0 {
			mods = mods&^viewerMod | serverMod
		}
		if name, c, v, ok := swapModKey(key, code, viewerMod, serverMod); ok {
			key, code, vk = name, c, v
		}
	}
	text := ""
	if k.Type == "keyDown" && mods&(ModCtrl|ModMeta) == 0 {
		text = keyText(key)
	}
	typ := k.Type
	if typ == "keyDown" && text == "" {
		typ = "rawKeyDown"
	}
	out := map[string]any{
		"type":                  typ,
		"key":                   key,
		"code":                  code,
		"windowsVirtualKeyCode": vk,
		"nativeVirtualKeyCode":  vk,
		"modifiers":             mods,
		"location":              k.Location,
		"autoRepeat":            k.Repeat,
	}
	if text != "" {
		out["text"] = text
		out["unmodifiedText"] = text
	}
	if serverMac && typ == "rawKeyDown" && mods&ModMeta != 0 && mods&(ModCtrl|ModAlt) == 0 {
		lower := key
		if len(lower) == 1 && lower[0] >= 'A' && lower[0] <= 'Z' {
			lower = string(lower[0] + 32)
		}
		if c, ok := macEditCommands[lower]; ok {
			if c == "undo" && mods&ModShift != 0 {
				c = "redo"
			}
			out["commands"] = []string{c}
		}
	}
	return out
}

// swapModKey 는 Mod 키 자체(Meta↔Control)를 서버 쪽 이름으로 바꾼다.
func swapModKey(key, code string, from, to int) (string, string, int, bool) {
	name := map[int]string{ModMeta: "Meta", ModCtrl: "Control"}
	vk := map[int]int{ModMeta: 91, ModCtrl: 17}
	if key != name[from] {
		return "", "", 0, false
	}
	side := "Left"
	if len(code) > len(name[from]) {
		side = code[len(name[from]):]
	}
	return name[to], name[to] + side, vk[to], true
}

// keyText 는 keyDown 이 넣을 글자다. 이름 있는 키 중 글자를 넣는 것은 Enter 하나다.
func keyText(key string) string {
	if key == "Enter" {
		return "\r"
	}
	if r := []rune(key); len(r) == 1 {
		return key
	}
	return ""
}
