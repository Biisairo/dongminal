#!/usr/bin/env bash
# Git 창 검증용 테스트 저장소 픽스처 (GIT_SRS V14 · V60).
#
# 손으로 만들기 번거로운 상태들을 한 번에 세운다 — 초기 커밋 전, detached HEAD,
# 머지 진행 중, 충돌, 대량 파일, 대량 커밋, bare remote, LFS 포인터, 바이너리,
# 유니코드·공백 경로. 각 저장소는 독립 디렉터리이므로 하나를 망가뜨려도 나머지는
# 그대로다.
#
# 사용:
#   e2e/git_fixture.sh [출력디렉터리]     # 기본: /tmp/dm-git-fixtures
#   e2e/git_fixture.sh --clean [디렉터리] # 지운다
#
# 이 스크립트는 **읽기 검증용 저장소를 만들 뿐이고 사용자의 저장소를 건드리지
# 않는다.** 출력 디렉터리 밖에는 어떤 파일도 쓰지 않는다.
set -euo pipefail

OUT="${2:-${1:-/tmp/dm-git-fixtures}}"
if [ "${1:-}" = "--clean" ]; then
  OUT="${2:-/tmp/dm-git-fixtures}"
  case "$OUT" in
    /|/Users|/Users/*/|"") echo "거부: 지우기에 안전하지 않은 경로 '$OUT'" >&2; exit 1 ;;
  esac
  [ -d "$OUT" ] || { echo "없음: $OUT"; exit 0; }
  [ -f "$OUT/.dm-git-fixture" ] || { echo "거부: $OUT 은 이 스크립트가 만든 디렉터리가 아니다" >&2; exit 1; }
  rm -rf "$OUT"
  echo "지웠다: $OUT"
  exit 0
fi

mkdir -p "$OUT"
: > "$OUT/.dm-git-fixture"   # --clean 의 안전 표식

# 파이썬은 이름이 하나가 아니다.
#
# 8번 픽스처(대량 커밋)가 `fast-import` 입력을 만드는 데 파이썬을 쓴다. 개발
# 호스트와 리눅스 러너에는 `python3` 가 있지만 **Windows 의 git-bash 에는 없다** —
# 거기서는 `python` 이 그것이다. 이름 하나만 부르면 스크립트가 통째로 멈추고,
# `set -e` 때문에 그 뒤의 픽스처도 서지 않는다 (Windows CI 에서 실측).
PY_BIN="$(command -v python3 || command -v python || true)"
if [ -z "$PY_BIN" ]; then
  echo "거부: python3(또는 python)이 없습니다 — 대량 커밋 픽스처를 만들 수 없습니다" >&2
  exit 1
fi

# 픽스처는 **사용자의 git 설정을 한 톨도 보지 않는다** (M6 `TEST-16`~`21` 의
# `TEST-21`).
#
#   이전 동작: 저장소마다 `user.name`·`user.email`·`commit.gpgsign` 셋만 덮었다.
#             나머지는 전부 호스트의 전역·시스템 설정이 그대로 이겼다 —
#             `init.defaultBranch`·`core.autocrlf`·`core.hooksPath`·`safe.directory`·
#             별칭·`includeIf`·`gpg.format`. 그중 어느 하나만 달라도 픽스처의
#             모양이 기계마다 갈리고, 그러면 e2e 의 실패가 **그 기계의 사실**이
#             된다 (재현되지 않는 실패가 그렇게 생긴다)
#   새  동작: 전역·시스템 설정을 통째로 끊는다
#   이유:     픽스처는 **닫힌 입력**이어야 한다. 세 값만 덮는 것은 "무엇이 새는지
#             아는 것" 을 전제하는데, 그 목록은 git 이 늘리는 것이지 우리가
#             정하는 것이 아니다
#
# `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` 은 git 2.32+ 다. 그보다 낮은 git 에서는
# 그 둘이 조용히 무시되므로 `GIT_CONFIG_NOSYSTEM` 을 함께 둔다 — 시스템 설정만은
# 어느 판에서도 끊긴다.
#
# `/dev/null` 은 git-bash(Windows)에도 있다. 빈 파일을 만들어 가리키지 않는 이유는
# 그 파일의 수명을 이 스크립트가 책임져야 하기 때문이다.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1
# 저장소마다의 설정은 그대로 둔다 — 아래 `init` 이 심는 셋이 그것이고, 그 셋은
# **픽스처의 사실**이지 호스트의 것이 아니다.
init() {
  local d="$OUT/$1"
  rm -rf "$d"; mkdir -p "$d"; git -C "$d" init -q -b main .
  git -C "$d" config user.name  "Fixture"
  git -C "$d" config user.email "fixture@example.invalid"
  git -C "$d" config commit.gpgsign false
  echo "$d"
}
say() { printf '  %-22s %s\n' "$1" "$2"; }

echo "픽스처 → $OUT"

# ── 1. 초기 커밋 전 (HEAD 없음) — FR-GIT-65 의 unstage 경로, V31 ──
d=$(init empty-no-commit)
printf 'staged before first commit\n' > "$d/a.txt"
git -C "$d" add a.txt
say empty-no-commit "커밋 0개 + staged 1개 (HEAD 없음)"

# ── 2. 기본 — 3그룹·rename·유니코드·공백 경로 — FR-GIT-34/36, V9 ──
d=$(init basic)
printf 'one\n' > "$d/tracked.txt"
printf 'x\n'   > "$d/renamed from.txt"
mkdir -p "$d/디렉터리 한글"
printf 'ko\n' > "$d/디렉터리 한글/파일 이름.txt"
git -C "$d" add -A; git -C "$d" commit -qm "init"
printf 'two\n' >> "$d/tracked.txt"                      # unstaged 수정
git -C "$d" mv "renamed from.txt" "renamed to.txt"      # staged rename
printf 'new\n' > "$d/untracked.txt"                     # untracked
printf 'both\n' >> "$d/디렉터리 한글/파일 이름.txt"
git -C "$d" add "디렉터리 한글/파일 이름.txt"
printf 'and more\n' >> "$d/디렉터리 한글/파일 이름.txt"  # staged + unstaged (indeterminate)
say basic "3그룹 + rename + 유니코드·공백 + indeterminate"

# ── 3. detached HEAD — FR-GIT-33/87, V22 ──
d=$(init detached)
printf 'a\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -qm "c1"
printf 'b\n' >> "$d/f.txt"; git -C "$d" commit -qam "c2"
git -C "$d" checkout -q --detach HEAD~1
say detached "detached HEAD"

# ── 4. 충돌 (머지 진행 중) — FR-GIT-37/86, V23 ──
d=$(init conflict)
printf 'base\n' > "$d/c.txt"; git -C "$d" add -A; git -C "$d" commit -qm "base"
git -C "$d" checkout -q -b side
printf 'side\n' > "$d/c.txt"; git -C "$d" commit -qam "side"
git -C "$d" checkout -q main
printf 'main\n' > "$d/c.txt"; git -C "$d" commit -qam "main"
git -C "$d" merge side -q 2>/dev/null || true    # 충돌로 실패하는 것이 목적이다
say conflict "unmerged 1개 + MERGE_HEAD (머지 진행 중)"

# ── 5. identity 미설정 — FR-GIT-86, V36 ──
d=$(init no-identity)
printf 'a\n' > "$d/f.txt"
git -C "$d" -c user.name=T -c user.email=t@t add -A
git -C "$d" -c user.name=T -c user.email=t@t commit -qm "init"
git -C "$d" config --unset user.name
git -C "$d" config --unset user.email
printf 'b\n' >> "$d/f.txt"; git -C "$d" add -A
say no-identity "user.name/email 미설정 (preflight 차단 대상)"

# ── 6. 바이너리 · LFS 포인터 · 대용량 — FR-GIT-46/47/48, V10 ──
d=$(init blobs)
printf 'PNG\x00\x01\x02binary payload\x00\n' > "$d/bin.dat"
cat > "$d/lfs.bin" <<'PTR'
version https://git-lfs.github.com/spec/v1
oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
size 123456789
PTR
# 1MB 상한(O2)을 넘기는 텍스트 파일
awk 'BEGIN{for(i=0;i<40000;i++) printf "line %d — 상한 초과 확인용 여백 텍스트\n", i}' > "$d/huge.txt"
git -C "$d" add -A; git -C "$d" commit -qm "blobs"
printf '\x00changed\n' >> "$d/bin.dat"
printf 'tail\n' >> "$d/huge.txt"
say blobs "바이너리 + LFS 포인터 + 1MB 초과 텍스트"

# ── 7. 대량 변경 파일 — FR-GIT-42, V25 ──
d=$(init many-files)
mkdir -p "$d/src"
awk 'BEGIN{for(i=0;i<2000;i++) print i}' | while read -r i; do printf 'v1\n' > "$d/src/f$i.txt"; done
git -C "$d" add -A; git -C "$d" commit -qm "2000 files"
awk 'BEGIN{for(i=0;i<2000;i++) print i}' | while read -r i; do printf 'v2\n' >> "$d/src/f$i.txt"; done
say many-files "변경 파일 2000개"

# ── 8. 대량 커밋 + 분기·머지 — FR-GIT-114~120, V46/V48 ──
# fast-import 로 만든다. commit --allow-empty 를 1만 번 돌리면 수십 초가 걸린다.
d=$(init many-commits)
# `PYTHONIOENCODING` 은 이 스크립트가 한국어를 찍기 때문이다. Windows 의 파이썬은
# stdout 을 그 기계의 코드 페이지(cp1252·cp949)로 인코딩하고, 그 표에 없는 글자를
# 만나면 `UnicodeEncodeError` 로 죽는다 — 마지막 한 줄의 진행 보고가 픽스처 전체를
# 쓰러뜨렸다(Windows CI 실측). `set -e` 때문에 그 뒤의 픽스처도 서지 않는다.
PYTHONIOENCODING=utf-8 "$PY_BIN" - "$d" <<'PY'
import subprocess, sys, time
repo = sys.argv[1]
N = 10000
BRANCHES = 6           # 주기적으로 갈라졌다 합쳐 DAG 를 만든다
ts = 1700000000
lines = []
mark = 0
def blob(text):
    global mark
    mark += 1
    lines.append(f"blob\nmark :{mark}\ndata {len(text)}\n{text}")
    return mark
head = None
side_heads = {}
for i in range(N):
    b = blob(f"line {i}\n")
    mark += 1
    cm = mark
    ref = "refs/heads/main"
    parents = []
    if head is not None:
        parents.append(f"from :{head}\n")
    # 200 커밋마다 사이드 브랜치를 만들고 그 다음에 머지한다
    if i % 200 == 100:
        side_heads[i] = head
    if i % 200 == 150 and (i - 50) in side_heads and side_heads[i - 50] is not None:
        parents.append(f"merge :{side_heads[i-50]}\n")
    msg = f"commit {i} — 유니코드 제목 · 개행 포함\n\nbody line\n"
    lines.append(
        f"commit {ref}\nmark :{cm}\n"
        f"author Fixture <fixture@example.invalid> {ts+i} +0000\n"
        f"committer Fixture <fixture@example.invalid> {ts+i} +0000\n"
        f"data {len(msg.encode())}\n{msg}"
        + "".join(parents)
        + f"M 100644 :{b} f{i % 50}.txt\n"
    )
    head = cm
lines.append(f"reset refs/heads/main\nfrom :{head}\n")
data = "\n".join(lines) + "\n"
t0 = time.time()
subprocess.run(["git", "-C", repo, "fast-import", "--quiet"],
               input=data.encode(), check=True)
subprocess.run(["git", "-C", repo, "reset", "--hard", "main", "-q"], check=True)
print(f"  many-commits           {N} 커밋 · {time.time()-t0:.1f}s")
PY
git -C "$d" tag v1.0 main~500
git -C "$d" tag v2.0 main~100

# ── 9. bare remote 를 가진 저장소 — FR-GIT-98~107, V40 ──
# **초기 브랜치를 못박는다** (M6 `TEST-21`).
#
#	이전 동작: `git init --bare` 뿐이었다. bare 저장소의 HEAD 가 가리키는 이름은
#	          `init.defaultBranch` 가 정하는데, 그 값은 **호스트의 전역 설정**에서
#	          왔다. 개발 호스트가 `main` 이라 우연히 맞았을 뿐이다
#	새  동작: `-b main`
#	이유:     이 스크립트가 전역 설정을 끊는 순간(위 `GIT_CONFIG_GLOBAL`) git 의
#	          내장 기본값은 `master` 다. 그러면 bare 의 HEAD 는 `master` 를
#	          가리키는데 실제로 밀리는 브랜치는 `main` 이고, 그 remote 를 clone 한
#	          쪽은 **체크아웃 없는 작업 트리**를 받는다 — `git commit -am` 이
#	          "커밋할 것이 없다" 로 실패한다 (전량에서 `git-remote` 여섯이 그렇게
#	          무너졌다).
#
# **픽스처는 자기 전제를 스스로 세운다** — `M5_PROGRESS §3-4` 가 같은 부류를 적었다.
git init -q --bare -b main "$OUT/remote.git"
d=$(init with-remote)
printf 'a\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -qm "init"
git -C "$d" remote add origin "$OUT/remote.git"
git -C "$d" push -q -u origin main
printf 'b\n' >> "$d/f.txt"; git -C "$d" commit -qam "ahead 1"   # ahead 1
git -C "$d" checkout -q -b no-upstream                          # upstream 없는 브랜치
printf 'c\n' > "$d/g.txt"; git -C "$d" add -A; git -C "$d" commit -qm "on no-upstream"
git -C "$d" checkout -q main
say with-remote "origin + ahead 1 + upstream 없는 브랜치"

# ── 10. stash 가 있는 저장소 — FR-GIT-161~170, V56 ──
d=$(init stashes)
printf 'a\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -qm "init"
printf 'wip1\n' >> "$d/f.txt"; git -C "$d" stash push -q -m "첫 번째 작업"
printf 'wip2\n' >> "$d/f.txt"; printf 'u\n' > "$d/new.txt"
git -C "$d" stash push -q -u -m "두 번째 (untracked 포함)"
printf 'wip3\n' >> "$d/f.txt"
say stashes "stash 2개 + 현재 변경 1개"

echo
echo "완료. 정리: e2e/git_fixture.sh --clean $OUT"
