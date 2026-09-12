/**
 * `core/contrast.js` 의 계약 (DESIGN_TOKENS_SRS §5.1, TC-TOK-1~7).
 *
 * 의존이 0 인 순수 함수이므로 브라우저 없이 잰다 — 이 저장소에서 순수 모듈은
 * 그렇게 한다 (`drop-entries.test.mjs` 의 선례).
 *
 * **이 검사가 곧 게이트의 근거다** (D-TOK-5). 게이트(`check-contrast.mjs`)와
 * 런타임(`applyThemeObj`)이 **같은 함수**를 부르므로, 여기서 참인 것이 화면에서도
 * 참이다. 둘이 갈라지면 게이트는 초록인데 화면은 미달이 된다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

// 고전 스크립트라 `import` 로 꺼낼 수 없다 — 이 저장소의 관용구를 따른다.
// `themes.js` 는 `TOPTS` 에 대입하므로 `contrast.js` 뒤에 함께 싣고 대역을 준다.
const ctx = load(['core/contrast.js', 'ui/themes.js'], {
  // `themes.js` 끝줄이 `TOPTS.theme` 에 대입한다 — 그 한 줄 때문에
  // `core/constants.js` 를 끌고 오지 않는다.
  globals: { TOPTS: {} },
  expose: ['CONTRAST_FLOORS', 'CONTRAST_STEP', 'THEMES'],
});
const {
  CONTRAST_FLOORS, CONTRAST_STEP, THEMES,
  relLuminance, contrastRatio, mixHex, liftContrast,
  pickContrastAnchor, deriveContrastTokens,
} = ctx;

const themeNames = Object.keys(THEMES);

// ── 0. 대역이 실제로 무엇을 싣고 있는지 ──────────────────────────────
//
// M6 §4-A-1 의 교훈: **아무것도 재지 않는 단정**을 만들지 않는다. 테마가 0개면
// 아래 54종 루프가 전부 공회전하면서 초록이 된다.
test('테마가 실제로 실렸다 (빈 루프로 초록이 되지 않는다)', () => {
  assert.ok(themeNames.length >= 50, `테마 ${themeNames.length}종 — 너무 적다`);
});

// ── 1. 대비 계산 자체 ────────────────────────────────────────────────
test('contrastRatio — WCAG 의 알려진 값', () => {
  // 흑백이 21:1 이라는 것이 WCAG 2.1 상대휘도 정의의 상한이다.
  assert.equal(+contrastRatio('#ffffff', '#000000').toFixed(2), 21);
  assert.equal(+contrastRatio('#000000', '#ffffff').toFixed(2), 21); // 순서 무관
  assert.equal(+contrastRatio('#ffffff', '#ffffff').toFixed(2), 1);
  // 흰 배경에서 AA 의 경계에 걸친 회색 한 쌍 — 한 눈금 차이로 갈린다.
  assert.equal(+contrastRatio('#767676', '#ffffff').toFixed(3), 4.542); // 넘는다
  assert.equal(+contrastRatio('#777777', '#ffffff').toFixed(3), 4.478); // 못 넘는다
});

test('relLuminance — 흑 0, 백 1', () => {
  assert.equal(relLuminance('#000000'), 0);
  assert.equal(relLuminance('#ffffff'), 1);
});

test('mixHex — 양 끝과 가운데', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
});

// ── TC-TOK-3. 이미 바닥을 넘는 값은 손대지 않는다 ────────────────────
test('TC-TOK-3 이미 넘는 값은 섞지 않는다 (mix=0, 색 그대로)', () => {
  const r = liftContrast('#ffffff', '#ffffff', ['#000000'], 4.5);
  assert.equal(r.mix, 0);
  assert.equal(r.color, '#ffffff');
});

test('TC-TOK-3 못 넘는 값은 최소량만 섞는다 — 한 스텝 덜 섞으면 미달', () => {
  const raw = '#333333', anchor = '#ffffff', bg = '#000000', floor = 4.5;
  const r = liftContrast(raw, anchor, [bg], floor);
  assert.ok(r.mix > 0, '섞였어야 한다');
  assert.ok(contrastRatio(r.color, bg) >= floor, '바닥을 넘어야 한다');
  const less = mixHex(raw, anchor, r.mix - CONTRAST_STEP);
  assert.ok(contrastRatio(less, bg) < floor, '한 스텝 덜 섞으면 미달이어야 최소량이다');
});

// ── TC-TOK-4. 참조 배경 둘 중 나쁜 쪽을 본다 ─────────────────────────
test('TC-TOK-4 배경 둘 중 나쁜 쪽을 기준으로 판정한다', () => {
  // 본문 배경에서는 통과하지만 사이드바 배경에서는 미달인 합성 값.
  const raw = '#767676', floor = 4.5;
  const bgMain = '#ffffff', bgSide = '#cccccc';
  assert.ok(contrastRatio(raw, bgMain) >= floor, '전제: 본문 배경에서는 통과');
  assert.ok(contrastRatio(raw, bgSide) < floor, '전제: 사이드바 배경에서는 미달');

  const one = liftContrast(raw, '#000000', [bgMain], floor);
  assert.equal(one.mix, 0, '배경 하나만 보면 손대지 않는다');

  const two = liftContrast(raw, '#000000', [bgMain, bgSide], floor);
  assert.ok(two.mix > 0, '둘을 보면 손대야 한다');
  assert.ok(contrastRatio(two.color, bgMain) >= floor);
  assert.ok(contrastRatio(two.color, bgSide) >= floor);
});

// ── TC-TOK-5. 앵커가 바닥을 못 넘으면 흑/백으로 내려간다 ─────────────
test('TC-TOK-5 앵커가 바닥에 못 미치면 모드의 흑/백을 앵커로 쓴다', () => {
  // textBright 가 배경 대비 2:1 뿐인 팔레트 — 그리로 섞어서는 7.0 에 닿지 못한다.
  const ui = {
    bg: '#000000', sidebarBg: '#000000',
    text: '#444444', textMuted: '#333333', textDim: '#222222',
    textBright: '#606060', accent: '#404040', danger: '#404040',
  };
  assert.ok(contrastRatio(ui.textBright, ui.bg) < CONTRAST_FLOORS.text, '전제: 앵커 후보가 미달');
  assert.equal(pickContrastAnchor(ui, 'dark'), '#ffffff');

  const ui2 = { ...ui, bg: '#ffffff', sidebarBg: '#ffffff', textBright: '#a0a0a0' };
  assert.equal(pickContrastAnchor(ui2, 'light'), '#000000');
});

test('TC-TOK-5 폴백은 모드가 아니라 대비로 고른다', () => {
  // 중간 밝기 배경에서는 `mode` 가 거짓말을 한다 — `dark` 인데 검은색이 더 세다.
  const ui = {
    bg: '#808080', sidebarBg: '#808080',
    text: '#8a8a8a', textMuted: '#858585', textDim: '#828282',
    textBright: '#909090', accent: '#7a7a7a', danger: '#877777',
  };
  assert.ok(contrastRatio('#000000', ui.bg) > contrastRatio('#ffffff', ui.bg), '전제: 검은 쪽이 세다');
  assert.equal(pickContrastAnchor(ui, 'dark'), '#000000', 'mode 가 dark 여도 센 쪽을 고른다');
});

test('TC-TOK-5 닿을 수 없는 팔레트에서도 앵커까지는 간다 (FR-TOK-17)', () => {
  // `#808080` 배경에서는 어떤 색도 7.0 에 닿지 못한다 — 그 대비가 존재하지 않는다.
  const bg = '#808080';
  assert.ok(contrastRatio('#000000', bg) < CONTRAST_FLOORS.text);
  assert.ok(contrastRatio('#ffffff', bg) < CONTRAST_FLOORS.text);
  const r = liftContrast('#8a8a8a', '#000000', [bg], CONTRAST_FLOORS.text);
  assert.equal(r.color, '#000000', '닿을 수 있는 가장 먼 곳을 준다');
  assert.equal(r.mix, 1);
  // 원래 색보다는 낫다 — 그것이 이 폴백의 값이다.
  assert.ok(contrastRatio(r.color, bg) > contrastRatio('#8a8a8a', bg));
});

test('TC-TOK-5 앵커가 충분하면 팔레트 안에 머문다 (색상을 잃지 않는다)', () => {
  const ui = {
    bg: '#1a1b26', sidebarBg: '#16161e',
    text: '#a9b1d6', textMuted: '#565f89', textDim: '#414868',
    textBright: '#c0caf5', accent: '#7aa2f7', danger: '#f7768e',
  };
  assert.equal(pickContrastAnchor(ui, 'dark'), '#c0caf5', 'textBright 가 앵커여야 한다');
});

// ── TC-TOK-7. 결정론 ─────────────────────────────────────────────────
test('TC-TOK-7 같은 입력이 같은 출력 · 스텝이 고정 0.05', () => {
  assert.equal(CONTRAST_STEP, 0.05);
  const ui = THEMES[themeNames[0]].ui;
  const a = plain(deriveContrastTokens(ui, THEMES[themeNames[0]].mode));
  const b = plain(deriveContrastTokens(ui, THEMES[themeNames[0]].mode));
  assert.deepEqual(a, b);
  // 섞은 비율은 스텝의 배수다. 배수 자체를 정수로 보는 것이 부동소수를 타지
  // 않는 유일한 꼴이다 — `n*0.05` 를 되돌려 견주면 0.35 가 0.35000000000000003 이 된다.
  const r = liftContrast('#333333', '#ffffff', ['#000000'], 4.5);
  assert.equal(r.mix * 20, Math.round(r.mix * 20));
});

// ── TC-TOK-1. 테마 54종 전부가 바닥을 넘는다 ─────────────────────────
test('TC-TOK-1 테마 전부에서 글자 토큰이 바닥을 넘는다', () => {
  const bad = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode);
    const bgs = [t.ui.bg, t.ui.sidebarBg];
    const want = {
      text: CONTRAST_FLOORS.text,
      textMuted: CONTRAST_FLOORS.muted,
      textHint: CONTRAST_FLOORS.hint,
      accentText: CONTRAST_FLOORS.strong,
      dangerText: CONTRAST_FLOORS.strong,
    };
    for (const [k, floor] of Object.entries(want)) {
      for (const bg of bgs) {
        const got = contrastRatio(d[k], bg);
        if (got < floor - 1e-9) bad.push(`${name}/${k} ${got.toFixed(2)} < ${floor}`);
      }
    }
  }
  assert.deepEqual(bad, [], `바닥 미달 ${bad.length}건`);
});

// ── TC-TOK-2. 세 단계 계층이 보존된다 ────────────────────────────────
//
// **이것이 D-TOK-4(사다리 바닥)의 존재 이유다.** 단일 바닥 4.5 를 주면 실측
// 54종 중 34종에서 이 단정이 깨진다 — 가장 흐리던 것이 중간을 추월한다.
test('TC-TOK-2 테마 전부에서 hint < muted < text 가 유지된다', () => {
  const bad = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode);
    const c = (x) => contrastRatio(x, t.ui.bg);
    const [h, m, x] = [c(d.textHint), c(d.textMuted), c(d.text)];
    if (!(h < m && m < x)) bad.push(`${name} ${h.toFixed(2)} / ${m.toFixed(2)} / ${x.toFixed(2)}`);
  }
  assert.deepEqual(bad, [], `계층 깨짐 ${bad.length}건`);
});

// `--text-bright` 는 `color:` 로 **103번** 쓰인다. 파생이 `--text` 를 7.0 까지
// 올리면 그것보다 흐린 "bright" 가 생길 수 있다 — 실측 6/54 에서 그랬고
// Solarized Light 의 `textBright` 는 4.39 로 AA 자체를 못 넘었다.
test('TC-TOK-2 textBright 가 text 보다 흐려지지 않는다', () => {
  const bad = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode);
    const worst = (c) => Math.min(...[t.ui.bg, t.ui.sidebarBg].map((bg) => contrastRatio(c, bg)));
    const [b, x] = [worst(d.textBright), worst(d.text)];
    if (b < x - 1e-9) bad.push(`${name} bright=${b.toFixed(2)} < text=${x.toFixed(2)}`);
  }
  assert.deepEqual(bad, [], `bright 역전 ${bad.length}건`);
});

test('TC-TOK-2 hint 와 muted 가 같은 색으로 뭉개지지 않는다', () => {
  const same = themeNames.filter((n) => {
    const d = deriveContrastTokens(THEMES[n].ui, THEMES[n].mode);
    return d.textHint === d.textMuted;
  });
  assert.deepEqual(same, [], '흐림 두 단계가 같은 색이 되면 계층이 사라진다');
});

// ── FR-TOK-5·9. `--bg-alt` 는 글자가 놓이는 **세 번째 배경**이다 ─────
//
// 정의만 하고 참조 배경에 넣지 않으면 그 표면 위에서만 조용히 미달이 된다 —
// 실측으로 `--text-hint` 가 4.33 까지 떨어졌다.
test('FR-TOK-5 --bg-alt 가 파생에서 나오고 --bg 와 구별된다', () => {
  const weak = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode);
    assert.ok(d.bgAlt, `${name}: --bg-alt 가 없다`);
    const sep = contrastRatio(d.bgAlt, t.ui.bg);
    if (sep < 1.05) weak.push(`${name} ${sep.toFixed(3)}`);
  }
  assert.deepEqual(weak, [], '표면이 배경과 구별되지 않으면 없는 것과 같다');
});

test('FR-TOK-9 글자 토큰이 --bg-alt 위에서도 바닥을 넘는다', () => {
  const bad = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode);
    for (const [k, floor] of [['text', CONTRAST_FLOORS.text], ['textMuted', CONTRAST_FLOORS.muted], ['textHint', CONTRAST_FLOORS.hint]]) {
      const got = contrastRatio(d[k], d.bgAlt);
      if (got < floor - 1e-9) bad.push(`${name}/${k} on bgAlt ${got.toFixed(2)} < ${floor}`);
    }
  }
  assert.deepEqual(bad, [], `--bg-alt 위 미달 ${bad.length}건`);
});

// ── 구문 강조색도 글자다 ─────────────────────────────────────────────
//
// `style-docrender.css` 가 `--term-magenta` 류 여섯을 읽으며 *"터미널 팔레트에서
// 파생하므로 편집기·터미널·렌더가 같은 색 세계를 쓴다"* (FR-DRV-13d) 고 적어
// 두었는데, **그 파생이 없었다** — 여섯 다 폴백으로 떨어지고 있었다.
test('FR-DRV-13d 구문 강조색이 터미널 팔레트에서 나온다', () => {
  const t = THEMES['Tokyo Night'];
  const d = deriveContrastTokens(t.ui, t.mode, null, t.terminal);
  for (const k of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
    assert.ok(d.syntax && d.syntax[k], `syntax.${k} 가 없다`);
  }
});

test('FR-A11Y-6 구문 강조색이 테마 전부에서 바닥을 넘는다', () => {
  const bad = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode, null, t.terminal);
    for (const [k, c] of Object.entries(d.syntax)) {
      for (const bg of [t.ui.bg, d.bgAlt]) {
        const got = contrastRatio(c, bg);
        if (got < CONTRAST_FLOORS.strong - 1e-9) bad.push(`${name}/${k} ${got.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `구문색 미달 ${bad.length}건`);
});

test('터미널 팔레트가 없으면 구문색도 내지 않는다', () => {
  const t = THEMES[themeNames[0]];
  assert.equal(deriveContrastTokens(t.ui, t.mode).syntax, undefined);
});

// ── TC-TOK-6. 사용자 지정 테마도 같은 파생을 지난다 ──────────────────
test('TC-TOK-6 임의의 팔레트(사용자 지정 테마)도 바닥을 넘는다', () => {
  // 사용자가 고를 법한 최악: 배경과 글자가 거의 같다.
  const ui = {
    bg: '#202020', sidebarBg: '#252525',
    text: '#262626', textMuted: '#232323', textDim: '#212121',
    textBright: '#2a2a2a', accent: '#242424', danger: '#282828',
  };
  const d = deriveContrastTokens(ui, 'dark');
  for (const [k, floor] of [['text', CONTRAST_FLOORS.text], ['textMuted', CONTRAST_FLOORS.muted], ['textHint', CONTRAST_FLOORS.hint]]) {
    for (const bg of [ui.bg, ui.sidebarBg]) {
      assert.ok(contrastRatio(d[k], bg) >= floor - 1e-9, `${k} 가 ${bg} 에서 미달`);
    }
  }
});

// ── FR-TOK-16. 팔레트는 불변이다 ─────────────────────────────────────
test('FR-TOK-16 파생이 팔레트를 고치지 않는다', () => {
  const t = THEMES[themeNames[0]];
  const before = plain(t.ui);
  deriveContrastTokens(t.ui, t.mode);
  assert.deepEqual(plain(t.ui), before);
});

// ── FR-TOK-11. 바닥이 사다리다 ───────────────────────────────────────
test('FR-TOK-11 바닥이 사다리다 (hint < muted < text)', () => {
  assert.ok(CONTRAST_FLOORS.hint < CONTRAST_FLOORS.muted);
  assert.ok(CONTRAST_FLOORS.muted < CONTRAST_FLOORS.text);
  assert.equal(CONTRAST_FLOORS.hint, 4.5); // AA 본문 하한
  assert.equal(CONTRAST_FLOORS.ui, 3); // WCAG 1.4.11 UI 컴포넌트
});

// ── FR-TOK-25. 포커스 링 ─────────────────────────────────────────────
//
// 지금 포커스 링은 `var(--accent)` 를 그대로 쓴다. 그것은 **경계·배경용**
// 원시값이고(FR-TOK-4) 바닥을 받지 않는다 — 실측 2/54(Ayu Light 2.62 ·
// Everforest Light 2.50)에서 WCAG 1.4.11 의 3:1 을 넘지 못한다. 포커스가
// 보이지 않으면 키보드 사용자는 자기가 어디 있는지 모른다.
test('FR-TOK-25 --focus-ring 이 테마 전부에서 3:1 을 넘는다', () => {
  const bad = [];
  for (const name of themeNames) {
    const t = THEMES[name];
    const d = deriveContrastTokens(t.ui, t.mode);
    for (const [bgName, bg] of [['bg', t.ui.bg], ['sidebarBg', t.ui.sidebarBg], ['bgAlt', d.bgAlt]]) {
      const got = contrastRatio(d.focusRing, bg);
      if (got < CONTRAST_FLOORS.ui - 1e-9) bad.push(`${name} on ${bgName} ${got.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, [], `포커스 링 미달 ${bad.length}건`);
});

// 바닥을 넘는 동안은 **손대지 않는다** (FR-TOK-8). 링이 무조건 글자색 쪽으로
// 끌려가면 52/54 에서 테마의 강조색이 이유 없이 바랜다.
test('FR-TOK-25 이미 3:1 을 넘는 테마에서는 --accent 그대로다', () => {
  const t = THEMES['Tokyo Night'];
  const d = deriveContrastTokens(t.ui, t.mode);
  assert.equal(d.focusRing, t.ui.accent);
});
