# 저장소 관찰 기준선 — git 크기

- 문서 상태: **기록용 기준선** · 최초 기록 2026-09-10 (M0)
- 상위 문서: [`MILESTONE_KICKOFF.md`](./MILESTONE_KICKOFF.md) M0 · [`06-docs-hygiene.md`](./06-docs-hygiene.md) §4
- 용도: **확정 결정 1(git 히스토리 재작성 안 함)** 을 대체하는 관찰 장치. 재작성으로 팩을
  줄이는 대신, 수치가 계속 늘어나는지를 주기적으로 본다.

---

## 1. 왜 재작성 대신 기준선인가

히스토리에 개명 전 바이너리 blob 28개(249,218,200 bytes)가 영구 보존되어 팩을 약
80 MiB 까지 불렸다(`06-docs-hygiene.md` §4 의 [P2]). `git filter-repo` 로 지울 수
있으나 **사용자가 재작성하지 않기로 확정했다**(`MILESTONE_KICKOFF.md` §0-1 결정 1).

- 13개 릴리스 태그의 해시가 바뀌면 `CHANGELOG.md` 13개 헤더가 태그·날짜까지 일치하는
  상태(감사 양호 판정)를 다시 세워야 한다.
- 기존 clone·fork 가 무효화된다.

대신 **재발 방지**(`.gitignore` 에 `/remote-terminal` 추가)와 **관찰**(이 문서)로 닫는다.
누적된 80 MiB 는 그대로 두고, 여기서 더 늘어나는지만 본다.

## 2. 기준선 (2026-09-10, M0 착수 시점)

측정 커밋: `5f57cc7b382127b09c6cece59801cd7513cbfc54`
(= M0 착수 전 HEAD. M0 은 히스토리를 건드리지 않으므로 완료 후에도 동일하다.)

```
$ git count-objects -vH
count: 4734
size: 26.00 MiB
in-pack: 11300
packs: 32
size-pack: 79.88 MiB
prune-packable: 0
garbage: 0
size-garbage: 0 bytes
```

총 git 데이터 ≈ 106 MiB (loose 26.00 + pack 79.88).

1MB 초과 blob (`git rev-list --objects --all | git cat-file --batch-check=...`):

| 경로 | blob 수 | 비고 |
|---|---|---|
| `remote-terminal` | 27 | 개명 전 루트 바이너리. 최대 9,105,986 bytes |
| `bin/dongminal` | 1 | 9,086,770 bytes. 개명 과정에서 생성 |
| **합계** | **28** | **249,218,200 bytes** (압축 전 원본 크기 합) |

`06-docs-hygiene.md` §4 의 감사 실측(28개 · 249,218,200 bytes)과 일치한다.
`count`/`size` 는 감사 기재값(`4775` · `26.40 MiB`)과 미세하게 다른데, 감사 이후
커밋이 쌓이고 loose object 가 팩으로 접히면서 생긴 통상적인 드리프트다.

## 3. 두 경로는 이제 막혀 있다

```
$ git check-ignore -v remote-terminal
.gitignore:47:/remote-terminal	remote-terminal

$ git check-ignore -v bin/dongminal
.gitignore:5:/bin	bin/dongminal
```

`remote-terminal` 규칙은 M0 에서 추가했다. 워킹트리에 그 이름의 파일은 없으므로
실질 재발 위험은 낮지만, 규칙이 없다는 사실 자체를 닫아 둔다.

## 4. 다시 재는 법

```bash
cd /Users/dykim/personal/dongminal
git count-objects -vH
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1=="blob" && $3>1000000 {n++; s+=$3} END {print n" blobs, "s" bytes"}'
```

**blob 수가 28을 넘으면** 새 대용량 산출물이 커밋된 것이다 — 어느 경로인지 찾아
`.gitignore` 에 넣는다. `size-pack` 만 완만히 느는 것은 정상(소스 커밋 누적)이다.

## 5. 관찰 기록

| 날짜 | 커밋 | count | size | in-pack | packs | size-pack | 1MB+ blob |
|---|---|---|---|---|---|---|---|
| 2026-09-10 (M0) | `5f57cc7` | 4734 | 26.00 MiB | 11300 | 32 | 79.88 MiB | 28 · 249,218,200 B |
