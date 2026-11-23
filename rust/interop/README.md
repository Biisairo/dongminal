# 상호 운용 검증 (interop)

`run.sh` 는 Go 판과 Rust 판을 섞어 돌려, 사용자가 차이를 알아채는지 확인합니다. 근거는 `docs/internal/RUST_PORT_SRS.md` 의 V-RSP-4(FR-RSP-20~23)입니다.

## 실행

```sh
rust/interop/run.sh --go <Go 바이너리> --rust <Rust 바이너리>            # 전체
rust/interop/run.sh --go … --rust … --only handover                      # 시나리오 하나
rust/interop/run.sh --go … --rust … --keep                               # 작업 폴더를 남긴다
```

- Go 바이너리는 기준선 `127ff7d9` 를 go1.27.2 로 빌드한 것입니다. 운영 바이너리와 같게 하려면 판과 데몬 지문을 새깁니다.

  ```sh
  fp=$(rust/scripts/hermetic.sh scripts/daemon-fingerprint.sh --os darwin --arch arm64)
  rust/scripts/hermetic.sh go build -trimpath -buildvcs=false \
    -ldflags "-X dongminal/internal/ctl/cli.Version=v1.3.7 -X dongminal/internal/ctl/cli.DaemonBuild=$fp" \
    -o /tmp/<폴더>/go-rel ./cmd/dongminal
  ```

- Rust 바이너리는 `rust/scripts/hermetic.sh env VERSION=v1.3.7 BINARY=<경로> scripts/build.sh` 로 만듭니다.

종료 코드는 다른 항목이 없으면 `0`, 있으면 `1`, 인자가 틀렸으면 `2` 입니다. 마지막 줄은 `같음 a, 다름 b` 입니다.

## 운영 보호 (C-RSP-1)

- 스크립트는 스스로 `rust/scripts/hermetic.sh` 아래에서 다시 실행됩니다. 뿌리는 `/tmp/dmi.XXXXXX` 입니다. 유닉스 소켓 경로 길이 상한(104바이트) 때문에 짧은 경로를 씁니다.
- 포트는 60400~60460 을 씁니다. 간선 노드 포트도 이 범위에 둡니다.
- 프로세스는 작업 폴더 안의 바이너리로 도는 것만 끕니다. 운영 PID(`prod-pids.sh`)는 끄지 않습니다.
- 서버의 판 확인(외부 요청)은 `server.json` 의 `updateCheck:false` 로 끕니다. 기준선에서는 `DONGMINAL_NO_UPDATE_CHECK` 가 먹지 않습니다.

## 시나리오

| 이름 | 요구 | 확인하는 것 |
|---|---|---|
| `dmctl-cross` | FR-RSP-21 | Go 서버와 Rust 서버 각각에 Go `dmctl` 과 Rust `dmctl` 을 붙입니다. 읽기 명령 22개의 stdout·stderr·종료 코드가 바이트 단위로 같아야 합니다(`quietMs` 값만 정규화). `send-input` 은 입력이 셸에 닿아야 하고, `rename-tab` 은 효과가 같아야 합니다 |
| `daemon-cross` | FR-RSP-21 | 한 판의 데몬에 다른 판의 서버(`start --server-only`)를 붙입니다. 데몬 pid·셸 pid·이전 출력이 유지되고, 입출력 왕복·새 도구·busy 조회가 되어야 합니다. 두 판의 `health` 는 자기 지문을 기준으로 "그대로"·"바뀌었습니다" 를 맞게 말해야 합니다 |
| `handover` | FR-RSP-22 | 같은 자리의 바이너리를 다른 판으로 바꾸고 `start` 합니다(Go→Rust 전환, Rust→Go 되돌리기, 대조군 go→go·rs→rs). 데몬 pid·셸 pid·출력이 유지되고, 지문이 바뀌어야 합니다. 교체 뒤 채팅 방, 홈 설치물(`bin/` 링크·훅·에이전트 자산), `start` 의 교체 안내가 대조군과 같아야 합니다 |
| `home-files` | FR-RSP-20 | 한 판이 쓴 홈(workspace 세대, 설정, 간선 설정·신원)을 다른 판이 읽습니다. API 응답이 같아야 하고, 다른 판의 workspace 를 고칠 수 있어야 하며, 처음 판으로 돌아와도 읽혀야 합니다. 같은 요청열이 남긴 파일이 바이트 단위로 같아야 합니다. 한 판의 `backup` 을 다른 판이 `restore` 합니다 |
| `ctl-cross` | FR-RSP-20·21 | 각 판의 `stop`·`stop --all` 을 Go 인스턴스와 Rust 인스턴스에 대어 출력과 효과가 같아야 합니다. 한 판이 쓴 홈에서 `config show/validate/get`·`rollback` 목록이 두 판에서 같아야 합니다. 다른 판의 `rollback --gen 1` 결과를 쓴 판이 읽어야 합니다 |
| `edge` | FR-RSP-23 | 세 노드 Go–Rust–Go, Rust–Go–Rust 를 간선으로 잇습니다. 초대·맺기·연결, 망 그림의 세 노드 온라인, 가운데 노드를 건너는 방 전파, 다른 판의 `dmctl chat-mcp` 가 받는 중계된 글, 간선 지우기의 전파, 반대 방향 초대를 확인합니다 |

## 범위 밖

- 브라우저가 있어야 하는 명령(`new-tab`·`open-editor` 등 배치 명령)은 다루지 않습니다. 같은 서버 표면은 8.1 e2e 가 다룹니다.
- 특권 헬퍼(`otp`, 채팅 강제 삭제·강퇴)는 C-RSP-1 때문에 시험하지 않습니다.
- Windows·Linux 상호 운용은 이 Mac 에서 돌릴 수 없습니다.
