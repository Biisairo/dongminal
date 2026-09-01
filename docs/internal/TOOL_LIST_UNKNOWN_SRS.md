# SRS: 도구 목록을 **모르는** 순간과 재연결 폭주 — IEEE 29148

## 1. 개요

### 1.1 목적

접수한 말은 한 줄이다.

> **"여전히 연결입력이 무한루프를 돌면서 들어오는 현상이 존재해 제대로 확인해봐."**

RECONNECT_STORM_SRS 가 닫은 창은 **없는 도구를 향한** 재접속이었다 (FR-RCS-1: `OP.EXIT`
을 받으면 다시 붙지 않는다). 지금 남은 것은 그 반대다 — **살아 있는 도구를 클라이언트가
죽었다고 판정하고 스스로 끊었다가 다시 붙는다.** 서버가 도구 목록을 *모르는* 순간에
`[]` 를 보내기 때문이며, 클라이언트에게 "모른다"와 "하나도 없다"는 구별되지 않는다.

### 1.2 범위

**포함**
- `/api/state` 의 도구 목록이 **미지(unknown)** 임을 표현하는 방법
- 미지일 때 클라이언트가 하지 않을 일 (도구 파괴·레이아웃 정리·전경 이름 삭제)
- 죽은 도구 청소가 **슬롯 키**를 다루는 방식

**미포함**
- 데몬 재접속 자체의 속도·전략 (§6 비목표 #1)
- `OP.EXIT` 판정과 백오프 (RECONNECT_STORM_SRS FR-RCS-1·3 그대로, §6 비목표 #2)
- 로그 로테이션 (§6 비목표 #3)

---

## 2. 현재 상태 (실측으로 확인한 사실)

### 2.1 관측 — 동시 종료 뒤에 오는 순차 재연결

`/tmp/dongminal.log`, 2026-09-01. `~/.dongminal/daemon.log` 는 16:00:39.144 에
`dongminald starting`, 16:00:39.159 에 `tools restored count=10` 을 적었다. 즉 데몬은
**0.02초 만에 도구 10개를 전부 되살렸다.** 그런데 브라우저는 그 뒤로 11초를 더 돌았다.

```
16:00:43.943~945  http GET /ws 200 …   ← 소켓 9개가 같은 밀리초에 닫힌다
16:00:44.004~124  ws connected ×10     ← 12ms 간격으로 순차 재연결
16:00:46.743~744  http GET /ws 200 …   ← 또 10개 동시 종료 (2.8초 뒤)
16:00:46.823~947  ws connected ×10
16:00:50.111~113  http GET /ws 200 …   ← 또
16:00:50.182~317  ws connected ×10
```

두 모양이 사슬의 양 끝을 가리킨다.

| 관측 | 읽는 법 |
|---|---|
| **동시** 종료 (같은 밀리초, 9~10개) | 한 클라이언트가 자기 소켓을 **한꺼번에** 닫았다 |
| **순차** 재연결 (12ms 간격, 10개) | 배열을 도는 루프가 하나씩 다시 만들었다 |

12ms 간격의 순차 생성은 `_applyRemoteWorkspace` 의
`for(const id of ok){ if(!this.tools.has(id)) this._mkTool(...) }` 와 모양이 같다.
서버 로그에 `readWS error` 도 `output relay stopped` 도 없다 — **서버가 닫은 것이
아니다.**

### 2.2 사슬 ① — `List()` 의 `nil` 이 "도구가 없다"로 옮겨진다

`toolclient/client.go:484`:

```go
func (pc *ToolClient) List() []map[string]interface{} {
	resp, err := pc.call("list", struct{}{})
	if err != nil {
		return nil          // ← RPC 실패. "모른다"
	}
	...
}
```

`handlers_api.go:216` 의 `/api/state` 는 그 `nil` 을 그대로 싣는다:

```go
json.NewEncoder(w).Encode(map[string]interface{}{
	"tools":     s.Tools.List(),      // null
	"workspace": ws,
})
```

클라이언트 `app-cmd.js:167` 은 `const sp=(st&&st.tools)||[]` 로 받는다. **`null` 이
`[]` 가 되는 자리다.** 그 뒤 `_applyRemoteWorkspace(sv, [])` 가 도는 결과:

```js
const ok=new Set([]);                                  // 빈 집합
for(const [id,p] of Array.from(this.tools.entries())){
  if(!ok.has(id)){ p.destroy(); this.tools.delete(id) } // ← 전부 파괴
}
for(const s of sv.windows){ s.layout=clean(s.layout, ok) }  // ← 레이아웃도 전부 지움
sv.windows=sv.windows.filter(s=>s&&(s.layout||this._isEditorWin(s)));
```

세 줄이 차례로 **살아 있는 도구 전부**, **그것을 담은 pane**, **pane 이 없어진 창**을
지운다. 다음 스냅숏이 정상 목록을 실어 오면 전부 되살아나고, 되살아난 도구는 새 소켓을
연다 — 관측된 "동시 종료 → 순차 재연결"이 그것이다.

**서버는 이 창을 이미 안다.** `handlers_ws.go:56` 이 같은 순간을 정확히 구별한다:

```go
if dc, ok := s.Tools.(interface{ Connected() bool }); ok && !dc.Connected() {
	log.Printf("ws … tool %s lookup during daemon reconnect; closing for retry", …)
	return          // OpExit 을 보내지 않는다 — 도구가 사라진 것이 아니므로
}
```

WS 경로는 "모른다"와 "없다"를 가르는데 **`/api/state` 만 가르지 않는다.** 고칠 자리는
그 비대칭이다.

### 2.3 `nil` 로는 "0개"와 "모른다"가 갈리지 않는다

`toolhub/manager.go:334` 는 `var out []map[string]interface{}` 로 시작해 도구가 없으면
`nil` 을 돌려준다. 데몬의 `list` 응답(`ipc/paned.go:294`)은 그것을 그대로 실으므로
**도구가 정말 0개일 때도 `"tools": null`** 이다. 따라서 `List()==nil` 을 미지의 근거로
삼을 수 없다 — 판정은 `call` 이 실패했는지에서 나와야 한다.

### 2.4 사슬 ② — 죽은 도구 청소가 슬롯 키를 모른다

`app-cmd.js:288~292`:

```js
const ok=new Set((serverPanes||[]).map(p=>p.id));    // 순수 toolId
for(const [id,p] of Array.from(this.tools.entries())){
  if(!ok.has(id)){ try{p.destroy()}catch{} this.tools.delete(id); … }
}
```

`this.tools` 의 키는 `_slotKey(id,slot)` 이다 (`app-slots.js:39`) — 칸 0 은 `id` 그대로,
칸 1 이상은 `id@1`. 위 루프는 그 복합 키를 **순수 `toolId` 집합과 직접 비교**하므로,
칸 1 이상의 인스턴스는 살아 있어도 `ok` 에 없다. 즉 **`workspace_changed` 가 올 때마다
슬롯 도구가 파괴되고 다음 `render()` 가 다시 만든다** (`renderer.js:451` `_mountTabBody`).

같은 판정을 `_slotReap`(`app-slots.js:489`)은 올바로 한다:

```js
for(const [k,p] of [...this.tools]){
  const i=this._slotOf(k); if(!i) continue;
  if(keepTools.get(i)?.has(this._slotBase(k))) continue;
  …
}
```

`_slotBase` 의 주석이 이 결함의 이름을 이미 적어 두었다 — *"렌더러의 편집기 회수가 자기
손으로 `@1` 만 잘라 내다가 칸 2·3 의 편집기를 매 render 마다 파괴했다 (FR-SVS-60)."*
같은 실수가 도구 청소에 한 번 더 있다.

### 2.5 배제한 가설 (근거)

| 가설 | 판정 | 근거 |
|---|---|---|
| 서버가 소켓을 닫는다 | **기각** | `readWS error`·`output relay stopped` 로그가 0건 |
| `OP.EXIT` 판정이 되살아났다 | **기각** | `tool … not found` 로그가 0건. 도구는 전부 살아 있었다 |
| SSE 구독이 죽어 정리가 안 돈다 (RECONNECT_STORM §2.5) | **기각** | 정리는 **돌았다.** 문제는 그것이 **잘못 돌았다**는 것이다 |
| 자동 새로고침이 페이지를 다시 연다 | **기각** | `version-watch.js:9` 는 자동 reload 를 하지 않는다 |
| 사용자의 수동 새로고침 3회 | **기각** | 세 사이클의 간격이 2.8s·3.4s 로 고르고, 매번 도구 10개 전부가 12ms 간격으로 재생성된다 — 손이 만드는 모양이 아니다 |

---

## 3. 요구사항

### 3.1 묶음 K — 미지의 표현 (FR-TLU)

**FR-TLU-1** `/api/state` 응답은 도구 목록이 **관측된 사실인지**를 함께 싣는다
(`toolsKnown`, boolean). 목록의 형태는 바뀌지 않는다 — 더하는 것은 그 목록을 믿어도
되는가에 대한 답뿐이다.

**FR-TLU-2** 판정의 근거는 **RPC 가 성공했는가**이다. `nil` 목록은 근거가 아니다
(§2.3) — 도구가 정말 0개인 경우와 갈리지 않는다.

**FR-TLU-3** 데몬을 쓰지 않는 직접 모드는 언제나 `toolsKnown:true` 다. 목록의 출처가
같은 프로세스 안이므로 모를 수 있는 순간이 없다.

**FR-TLU-4** `toolsKnown:false` 여도 워크스페이스 스냅숏은 그대로 실어 보낸다. 워크스페이스
는 웹서버가 소유하며 데몬의 사정과 무관하다.

### 3.2 묶음 L — 모를 때 하지 않는 일 (FR-TLU)

**FR-TLU-5** `toolsKnown:false` 인 스냅숏으로는 **도구를 파괴하지 않는다.**

**FR-TLU-6** 같은 스냅숏으로 **레이아웃을 정리하지 않는다** — 도구를 모르면 어떤 pane 이
죽은 것인지도 모른다. `clean(layout, ok)` 의 `ok` 는 그때 **클라이언트가 이미 아는 도구
집합**이며, 그것으로 도는 정리는 정의상 아무것도 지우지 않는다.

**FR-TLU-7** 같은 스냅숏으로 **전경 프로그램 이름을 지우지 않는다** (`_fgApply`).

**FR-TLU-8** 미지는 **적용을 미루는 것이 아니라 도구에 관한 부분만 건너뛰는 것**이다.
워크스페이스의 구조 변경(창·탭·분할)은 그대로 적용된다 — 그것은 도구 목록을 몰라도
참이다.

**FR-TLU-9** 최초 로드(`App.init`)에서 `toolsKnown:false` 를 만나면 **짧게 기다렸다 다시
받는다.** 첫 화면은 복원의 유일한 기회이므로, 여기서 도구를 모른 채 진행하면 사용자는
탭이 사라진 화면을 먼저 본다. 재시도는 상한이 있고, 상한을 넘으면 있는 것으로 진행한다 —
데몬이 영영 돌아오지 않는 경우에도 화면은 서야 한다.

### 3.3 묶음 M — 슬롯 키 (FR-TLU)

**FR-TLU-10** 죽은 도구 청소는 Map 의 키가 아니라 **`_slotBase(key)`** 를 서버 목록과
비교한다. 칸 1 이상의 살아 있는 인스턴스는 파괴되지 않는다.

**FR-TLU-11** 알람 해제(`_attnDrop`)에 넘기는 것도 `_slotBase(key)` 다 — 알람은 도구의
것이지 칸의 것이 아니다.

**FR-TLU-12** 칸이 사라져 인스턴스를 회수하는 일은 여전히 `_slotReap` 의 것이다
(FR-WSL-21). 이 요구는 그 자리를 바꾸지 않는다.

---

## 4. 설계 결정

**D-1. 목록의 모양을 바꾸지 않고 플래그를 더한다.** `tools:null` 과 `tools:[]` 를 갈라
쓰는 길도 있으나, JSON 을 지나면 둘 다 "값이 없다"로 읽히기 쉽고 `(st.tools)||[]` 같은
기존 방어가 그 차이를 조용히 삼킨다 (§2.2 가 정확히 그 자리다). **읽는 쪽이 실수하기
어려운 표현**은 별도의 boolean 이다.

**D-2. 판정은 `call` 의 실패에서 나온다.** `Connected()` 만 보면 연결은 살아 있는데 그
한 번의 RPC 가 타임아웃한 경우를 놓친다. `ListOK() ([]…, bool)` 을 `ToolClient` 에 두고
`List()` 가 그것에 위임하면, 판정의 자리가 **RPC 를 실제로 한 곳** 하나로 모인다.

**D-3. `apiStateGet` 은 인터페이스 조회로 붙는다.** `ToolHub` 인터페이스에 메서드를
더하면 fake 를 포함한 모든 구현이 따라와야 한다. `handlers_ws.go:56` 이 이미 쓰는
`interface{ … }` 타입 단언과 같은 규약으로 붙인다 — 없으면 `true`(직접 모드, FR-TLU-3).

**D-4. 모를 때는 `ok` 를 "아는 것"으로 바꾼다.** 분기를 세 자리(생성·청소·`clean`)에
심는 대신 `ok` 집합 하나를 갈아 끼우면 세 곳이 자동으로 옳게 돈다 — 생성 루프는 이미
있는 것만 보므로 no-op, 청소 루프도 no-op, `clean` 은 현상 유지. **분기가 하나면 한쪽만
고쳐질 수 없다** (§2.4 가 그 사고였다).

**D-5. `init` 만 재시도한다.** 그 뒤의 경로는 SSE 가 다음 `workspace_changed` 를 나르므로
스스로 회복한다. 첫 화면에는 그 보증이 없다.

---

## 5. 검증

| ID | 요구 | 검증 |
|---|---|---|
| TC-TLU-1 | FR-TLU-1·3 | 직접 모드 `/api/state` 응답에 `toolsKnown:true` 가 있다 |
| TC-TLU-2 | FR-TLU-2 | `ListOK` 가 RPC 실패에 `(nil,false)`, 도구 0개에 `(nil,true)` 를 준다 |
| TC-TLU-3 | FR-TLU-1·4 | 데몬 미연결에서 `/api/state` 가 `toolsKnown:false` 와 **정상 워크스페이스**를 함께 준다 |
| TC-TLU-4 | FR-TLU-5 | `toolsKnown:false` 스냅숏을 적용해도 `app.tools` 의 크기가 줄지 않는다 |
| TC-TLU-5 | FR-TLU-6 | 같은 스냅숏 뒤에도 창·pane·탭 수가 그대로다 |
| TC-TLU-6 | FR-TLU-7 | 같은 스냅숏 뒤에도 전경 이름이 붙어 있는 탭 라벨이 그대로다 |
| TC-TLU-7 | FR-TLU-8 | 같은 스냅숏이 실어 온 **새 창**은 적용된다 |
| TC-TLU-8 | FR-TLU-9 | `init` 이 `toolsKnown:false` 를 받으면 다시 받고, 두 번째 응답의 도구로 화면을 세운다 |
| TC-TLU-9 | FR-TLU-10 | 칸 2개에 같은 도구가 선 상태에서 `workspace_changed` 를 적용해도 `id@1` 인스턴스가 살아 있다 |
| TC-TLU-10 | FR-TLU-10 | 같은 상황에서 새 WebSocket 이 열리지 않는다 (재연결 0회) |
| TC-TLU-11 | FR-TLU-10 | 서버 목록에서 빠진 도구는 두 칸 모두에서 파괴된다 (청소가 죽지 않았다) |

---

## 6. 비목표

1. 데몬 재접속의 속도·전략을 바꾸지 않는다.
2. `OP.EXIT` 판정과 백오프(FR-RCS-1·3)를 바꾸지 않는다.
3. 로그 로테이션을 다루지 않는다.
4. 칸 회수(`_slotReap`)의 자리를 옮기지 않는다.
