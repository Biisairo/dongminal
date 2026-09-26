package browser

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
)

// 3단계 충실도의 격리 world 보고자 (BROWSER_TAB_SRS 묶음 Q, FR-BRT-67·82·83·87·88·89).
//
// screencast 는 페이지의 합성 화면만 준다 — 커서·툴팁·검증 말풍선·네이티브 위젯·컨텍스트
// 메뉴는 그 밖이다. 격리 world 의 스크립트가 그 순간들을 보고하고(`__dmReport`), 뷰어가
// **자기 기기**에서 다시 그린다. 보고의 문자열(옵션·툴팁·URL)은 신뢰하지 않는 데이터다 —
// 뷰어는 텍스트로만 그린다 (NFR-BRT-S2).

// reportBinding 은 격리 world 에서만 보이는 보고 함수의 이름이다.
const reportBinding = "__dmReport"

// EvReport 는 격리 world 의 보고다 — Info 가 보고 JSON 이다.
const EvReport = "report"

// agentScript 는 격리 world 에 심는 보고자다. 페이지 DOM 에 흔적을 남기지 않는다.
const agentScript = `(() => {
  if (window.__dmAgent) return; window.__dmAgent = true;
  const send = (m) => { try { __dmReport(JSON.stringify(m)) } catch (e) {} };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height} };
  let lastCursor = '', lastTip = '';
  addEventListener('mousemove', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const c = el ? getComputedStyle(el).cursor : 'auto';
    if (c !== lastCursor) { lastCursor = c; send({t: 'cursor', v: c}) }
    const tipEl = el && el.closest('[title]');
    const tip = tipEl ? (tipEl.getAttribute('title') || '') : '';
    if (tip !== lastTip) { lastTip = tip; send({t: 'tooltip', v: tip, x: e.clientX, y: e.clientY}) }
  }, true);
  const selected = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number' &&
        a.selectionEnd > a.selectionStart) {
      return a.value.substring(a.selectionStart, a.selectionEnd);
    }
    return String(getSelection() || '');
  };
  for (const k of ['copy', 'cut']) addEventListener(k, () => { const s = selected(); if (s) send({t: 'copy', v: s}) }, true);
  const caret = () => {
    const a = document.activeElement;
    if (!a || a === document.body) return;
    let r = null;
    if (a.isContentEditable) { const s = getSelection(); if (s && s.rangeCount) r = s.getRangeAt(0).getBoundingClientRect() }
    if (!r || (!r.width && !r.height)) r = a.getBoundingClientRect();
    send({t: 'caret', x: r.left, y: r.bottom});
  };
  document.addEventListener('selectionchange', caret);
  addEventListener('focusin', caret, true);
  addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : null;
    const a = t && t.closest('a[href]'), img = t && t.closest('img');
    send({t: 'menu', x: e.clientX, y: e.clientY, href: a ? a.href : '', img: img ? img.currentSrc || img.src : '', sel: selected()});
  });
  addEventListener('invalid', (e) => {
    const el = e.target; if (!(el instanceof Element)) return;
    send(Object.assign({t: 'invalid', v: el.validationMessage || ''}, rectOf(el)));
  }, true);
  const widgets = new Map(); let nextId = 0;
  window.__dmSet = (id, v) => {
    const el = widgets.get(id); if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  };
  const PICK = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color']);
  const widget = (el, e) => {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
    const kind = PICK.has(el.type) ? el.type : (el.list ? 'datalist' : '');
    if (!kind) return false;
    if (kind !== 'datalist') e.preventDefault();
    const id = ++nextId; widgets.set(id, el);
    const opts = el.list ? [...el.list.options].map(o => ({value: o.value, label: o.label || o.value})) : [];
    send(Object.assign({t: 'widget', id, kind, value: el.value, min: el.min, max: el.max, step: el.step, opts}, rectOf(el)));
    return true;
  };
  addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (widget(t, e)) return;
    const a = t.closest('a[href]');
    if (!a) return;
    const u = a.href;
    if (/^(https?|file|about|blob|data|javascript):/i.test(u)) return;
    e.preventDefault();
    send({t: 'extlink', href: u});
  }, true);
  addEventListener('keydown', (e) => {
    const t = e.target;
    if ((e.key === ' ' || e.key === 'Enter') && t instanceof HTMLInputElement && PICK.has(t.type)) widget(t, e);
  }, true);
  // 찾기 (FR-BRT-89) — CSS Custom Highlight 로 칠한다. 교차 출처 iframe 안은 찾지 않는다.
  const sheet = new CSSStyleSheet();
  sheet.insertRule('::highlight(dm-find) { background: #ff0; color: #000 }');
  sheet.insertRule('::highlight(dm-find-cur) { background: #f80; color: #000 }', 1);
  const adopt = () => { if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet] };
  let hits = [], cur = -1, lastQ = '';
  window.__dmFind = (q, dir) => {
    adopt();
    if (q !== lastQ || !hits.length) {
      lastQ = q; hits = []; cur = -1;
      if (q) {
        const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        const lq = q.toLowerCase();
        for (let n = w.nextNode(); n && hits.length < 1000; n = w.nextNode()) {
          const s = n.data.toLowerCase(); let i = 0;
          while ((i = s.indexOf(lq, i)) >= 0 && hits.length < 1000) { const r = new Range(); r.setStart(n, i); r.setEnd(n, i + q.length); hits.push(r); i += q.length }
        }
      }
    }
    if (!hits.length) { CSS.highlights.delete('dm-find'); CSS.highlights.delete('dm-find-cur'); return {count: 0, index: 0} }
    cur = dir < 0 ? (cur <= 0 ? hits.length - 1 : cur - 1) : (cur + 1) % hits.length;
    CSS.highlights.set('dm-find', new Highlight(...hits));
    CSS.highlights.set('dm-find-cur', new Highlight(hits[cur]));
    const el = hits[cur].startContainer.parentElement; if (el) el.scrollIntoView({block: 'center'});
    return {count: hits.length, index: cur + 1};
  };
  window.__dmFindClear = () => { hits = []; lastQ = ''; CSS.highlights.delete('dm-find'); CSS.highlights.delete('dm-find-cur') };
})();`

// worldContext 는 이 페이지 최상위 프레임의 격리 world 실행 컨텍스트다.
func (pg *page) worldContext() int {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	return pg.worldCtx
}

// onContext 는 실행 컨텍스트의 생겨남·사라짐이다 — 격리 world 의 것만 적는다.
func (pg *page) onContext(method string, params json.RawMessage) {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	switch method {
	case "Runtime.executionContextCreated":
		var p struct {
			Context struct {
				ID      int    `json:"id"`
				Name    string `json:"name"`
				AuxData struct {
					FrameID string `json:"frameId"`
				} `json:"auxData"`
			} `json:"context"`
		}
		json.Unmarshal(params, &p)
		if p.Context.Name == isolatedWorld && p.Context.AuxData.FrameID == pg.target {
			pg.worldCtx = p.Context.ID
		}
	case "Runtime.executionContextDestroyed":
		var p struct {
			ID int `json:"executionContextId"`
		}
		json.Unmarshal(params, &p)
		if p.ID == pg.worldCtx {
			pg.worldCtx = 0
		}
	case "Runtime.executionContextsCleared":
		pg.worldCtx = 0
	}
}

// worldEval 은 격리 world 에서 식 하나를 계산한다.
func (pg *page) worldEval(ctx context.Context, expr string) (json.RawMessage, error) {
	id := pg.worldContext()
	if id == 0 {
		return nil, errors.New("페이지가 아직 준비되지 않았습니다")
	}
	res, err := pg.call(ctx, "Runtime.evaluate", map[string]any{"expression": expr, "contextId": id, "returnByValue": true})
	if err != nil {
		return nil, err
	}
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(res, &r)
	return r.Result.Value, nil
}

// find 는 탭의 찾기 막대다 (FR-BRT-89). 빈 질의는 칠한 것을 지운다.
func (pg *page) find(ctx context.Context, q string, dir int) (json.RawMessage, error) {
	if q == "" {
		return pg.worldEval(ctx, `(window.__dmFindClear && __dmFindClear(), {count: 0, index: 0})`)
	}
	return pg.worldEval(ctx, `__dmFind(`+strconv.Quote(q)+`, `+strconv.Itoa(dir)+`)`)
}

// setWidget 은 뷰어가 고른 위젯 값을 넣는다 (FR-BRT-88) — input·change 를 일으킨다.
func (pg *page) setWidget(ctx context.Context, id int, value string) error {
	v, err := pg.worldEval(ctx, `__dmSet(`+strconv.Itoa(id)+`, `+strconv.Quote(value)+`)`)
	if err != nil {
		return err
	}
	if string(v) != "true" {
		return errors.New("그 입력 요소가 없습니다")
	}
	return nil
}
