#!/usr/bin/env bash
# Git 창 검증용 테스트 저장소 픽스처 (GIT_SRS V14 · V60).
#
# 손으로 만들기 번거로운 상태들을 한 번에 세운다 — 초기 커밋 전, detached HEAD,
# 머지 진행 중, 충돌, 대량 파일, 대량 커밋, bare remote, LFS 포인터, 바이너리,
# 유니코드·공백 경로. 각 저장소는 독립 디렉터리이므로 하나를 망가뜨려도 나머지는
# 그대로다.
#
# 사용:
#   scripts/git_fixture.sh [출력디렉터리]     # 기본: /tmp/dm-git-fixtures
#   scripts/git_fixture.sh --clean [디렉터리] # 지운다
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

# 픽스처는 사용자의 전역 설정에 의존하지 않는다 — user.name 이 없는 환경에서도
# 스크립트가 성립해야 하고, preflight 검증(FR-GIT-86)이 전역 설정에 흔들리면 안 된다.
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
python3 - "$d" <<'PY'
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
git init -q --bare "$OUT/remote.git"
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
echo "완료. 정리: scripts/git_fixture.sh --clean $OUT"
