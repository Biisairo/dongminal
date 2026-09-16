# SRS: 편집기 미니맵 토글 (IEEE 29148 준수)

> **문서 상태**: 승인·구현중

## 1. 개요

### 1.1 목적

Monaco 편집기의 미니맵을 **설정에서 끌 수 있게** 한다. 지금은 `minimap.enabled` 가
코드에 `true` 로 박혀 있어 끄는 길이 없다.

### 1.2 범위

`Settings ▸ Display` 의 스위치 하나와 그것이 얹히는 자리다. 미니맵의 **모양**
(`size:'fill'` · `scale` · `showSlider`)은 이 스펙의 범위 밖이며 종전 그대로다
(UX_BATCH8_SRS FR-MMP-1·2 가 그 값을 정한 근거를 든다).

### 1.3 비목표

- diff 화면의 미니맵. 그쪽은 `constants-git-diff.js` 가 이미 `enabled:false` 로
  고정하며(M9_SRS §2.3 B5) 이 설정을 따르지 않는다 — `editorWordWrap` 과 같은 경계다.
- 미니맵 폭·배율의 사용자 조절.

## 2. 전체 기술

### 2.1 선례를 그대로 딛는다

`editorWordWrap`(WORKBENCH_REVIEW_SRS FR-WBR-10·11)이 **같은 모양**의 설정이다.
전역 변수 · 스키마 한 줄 · `ds-row` 체크박스 · 카탈로그 두 키 · `_init*` ·
`_edApply*` · 편집기의 `apply*` — 일곱 자리가 그 선례에 있고, 이 설정은 그 자리를
하나도 늘리거나 줄이지 않는다.

### 2.2 이전 동작 / 새 동작

| | 이전 | 새 |
|---|------|-----|
| 미니맵 | 언제나 켜짐 (코드 상수) | 설정이 정한다. **기본은 켜짐** |
| 이미 열린 편집기 | — | 스위치를 누른 즉시 따라간다 |
| diff 화면 | 꺼짐 | **그대로 꺼짐** |

**기본이 켜짐인 이유**: 기본을 끔으로 두면 이 변경만으로 모든 사용자의 화면이
바뀐다. 설정을 더하는 일이 동작을 바꾸는 일이 되어서는 안 된다.

## 3. 요구사항

| ID | 요구사항 | 등급 |
|----|----------|------|
| FR-MMT-1 | `Settings ▸ Display` 에 `편집기 미니맵` 행이 선다. 컨트롤은 체크박스(`#ds-minimap`)이며 줄바꿈 행과 같은 모양이다 (SETTINGS_CONTROLS_SRS FR-SCT-1) | 필수 |
| FR-MMT-2 | 값은 설정 블롭의 `editorMinimap`(bool, 기본 `true`)이다. 스키마 표에 한 줄이 선다 (CONFIG_MANAGEMENT_SRS FR-CFG-10) | 필수 |
| FR-MMT-3 | 편집기를 새로 열 때 그 값이 `minimap.enabled` 로 간다 | 필수 |
| FR-MMT-4 | **이미 열려 있는 편집기도 곧바로 따라간다** — `updateOptions` 이므로 모델·커서·편집 중인 내용을 잃지 않는다 (FR-WBR-11 과 같은 근거) | 필수 |
| FR-MMT-5 | 미니맵 옵션 덩이는 **한 자리에서 만든다** — 생성과 갱신이 같은 객체를 딛는다. 두 자리에 적으면 한쪽만 고쳐지는 날이 온다 | 필수 |
| FR-MMT-6 | 설정 창을 열 때마다 체크박스가 현재 값으로 다시 칠해진다 (FR-LVC-3 과 같은 근거) | 필수 |
| FR-MMT-7 | 문구는 카탈로그 키다 — `html.minimap` · `html.minimap_hint`, ko·en 한 벌 | 필수 |
| FR-MMT-8 | diff 화면은 이 설정을 따르지 않는다 | 필수 |

## 4. 검증

| ID | 층 | 내용 |
|----|-----|------|
| V-MMT-1 | Go 단위 | 서술자 표가 `editorMinimap` 을 포함해 25개다 |
| V-MMT-2 | e2e | 스위치를 끄면 **열려 있는** 편집기의 `getRawOptions().minimap.enabled` 가 거짓이 되고, 켜면 참으로 돌아온다 |
| V-MMT-3 | e2e | 값이 `/api/settings` 블롭에 실리고, 새로고침 뒤에도 유지된다 |
| V-MMT-4 | gates | `check-i18n` · `check-html` 통과 — 한글 리터럴 0, ko·en 한 벌 |

## 5. 리스크

| 리스크 | 등급 | 완화 |
|--------|------|------|
| `updateOptions` 의 부분 병합으로 `size`·`scale` 이 날아감 | LOW | FR-MMT-5 — 덩이를 통째로 넘긴다 |
| 기존 사용자의 화면이 바뀜 | LOW | 기본이 켜짐이라 바뀌지 않는다 |
