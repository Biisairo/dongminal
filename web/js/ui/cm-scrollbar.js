/**
 * 편집기 칸의 세로 스크롤바와 overview ruler — CODEMIRROR_MIGRATION_SRS FR-CMR-70~74 · §11.3.
 *
 * 브라우저 스크롤바는 숨기고 track·thumb 를 DOM 으로 그린다. ruler 는 그 track 위에 겹친 canvas 다.
 * 미니맵의 뷰포트 표시도 `edScrollThumb` 를 쓴다(FR-CMR-61) — 두 표시가 같은 자리에 서는 근거가 이 함수다.
 *
 * ruler 의 출처는 Facet `edRulerSource()` 다. 출처 하나는 `(state) => [{from, to, lane, color}]` 이고,
 * `lane` 은 `'left'`·`'right'`·`'full'`(전체 폭, 높이 `ED_RULER_CURSOR_H` — EDITOR_LINK_LSP_SRS FR-ELS-33),
 * `color` 는 CSS 변수 이름이다.
 */

/**
 * thumb 의 자리. 넘치지 않으면 `visible:false` 이고 track 전체 높이다.
 * @param {{scrollTop:number, scrollHeight:number, clientHeight:number, trackHeight:number}} g
 */
function edScrollThumb(g) {
  const track = Math.max(0, g.trackHeight);
  const range = g.scrollHeight - g.clientHeight;
  if (range <= 0 || track <= 0) return { top: 0, height: track, visible: false };
  const height = Math.min(track, Math.max(ED_SCROLL_MIN_THUMB, track * g.clientHeight / g.scrollHeight));
  const ratio = Math.min(1, Math.max(0, g.scrollTop / range));
  return { top: (track - height) * ratio, height, visible: true };
}

/** thumb 의 top 에서 scrollTop 을 되돌린다 — `edScrollThumb` 의 역. */
function edScrollFromThumb(top, g) {
  const range = g.scrollHeight - g.clientHeight;
  if (range <= 0) return 0;
  const th = edScrollThumb({ ...g, scrollTop: 0 });
  const free = g.trackHeight - th.height;
  if (free <= 0) return 0;
  return Math.min(1, Math.max(0, top / free)) * range;
}

/** FR-CMR-71: 줄 top 을 track 의 세로 위치로. */
function edRulerY(top, contentHeight, trackHeight) {
  if (contentHeight <= 0) return 0;
  return Math.min(1, Math.max(0, top / contentHeight)) * trackHeight;
}

/** 칸의 스크롤 기하. 미니맵 포크의 `thumb` 설정도 이것을 쓴다. */
function edScrollGeo(view) {
  const s = view.scrollDOM;
  return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, trackHeight: s.clientHeight };
}

// 처음 쓸 때 만든다 — 이 파일은 `CM` 이 실리기 전에 읽힌다 (`cm-buffer.js` 와 같은 이유).
function edRulerSource() {
  if (!edRulerSource.facet) edRulerSource.facet = CM.Facet.define();
  return edRulerSource.facet;
}

/** 칸의 ruler 가 마지막으로 그린 항목 — `[{from, to, lane, color, cls?}]` (e2e 어댑터가 읽는다). */
function edCmRulerItems(view) {
  const p = view.plugin(edCmScrollbarPlugin());
  return p ? p.items : [];
}

function edCmScrollbarPlugin() {
  if (edCmScrollbarPlugin.plugin) return edCmScrollbarPlugin.plugin;
  edCmScrollbarPlugin.plugin = CM.ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.items = [];
      this.track = document.createElement('div');
      this.track.className = 'cm-vscroll';
      this.ruler = document.createElement('canvas');
      this.ruler.className = 'cm-vscroll-ruler';
      this.thumb = document.createElement('div');
      this.thumb.className = 'cm-vscroll-thumb';
      this.track.append(this.ruler, this.thumb);
      view.dom.appendChild(this.track);
      this.track.addEventListener('mousedown', (e) => this.onDown(e));
      this.onMove = (e) => this.drag(e);
      this.onUp = () => this.stop();
      this.measure = { key: this, read: () => this.read(), write: (m) => this.write(m) };
      view.requestMeasure(this.measure);
    }

    update(u) {
      const src = u.state.facet(edRulerSource()) !== u.startState.facet(edRulerSource());
      if (u.docChanged || u.selectionSet || u.geometryChanged || u.heightChanged || u.viewportChanged || src
        || u.transactions.some((tr) => tr.effects.length)) {
        this.view.requestMeasure(this.measure);
      }
    }

    // FR-CMR-73: 다음 프레임에 한 번 — requestMeasure 는 같은 key 를 한 번으로 모은다.
    read() {
      const v = this.view;
      const geo = edScrollGeo(v);
      const top = v.scrollDOM.offsetTop;
      const contentH = v.contentHeight;
      const items = [];
      for (const src of v.state.facet(edRulerSource())) {
        for (const it of src(v.state)) {
          const y = edRulerY(v.lineBlockAt(it.from).top, contentH, geo.trackHeight);
          const y2 = edRulerY(v.lineBlockAt(it.to).bottom, contentH, geo.trackHeight);
          items.push({ ...it, y, h: it.lane === 'full' ? ED_RULER_CURSOR_H : Math.max(ED_RULER_MIN_H, y2 - y) });
        }
      }
      return { geo, top, items };
    }

    write(m) {
      const { geo, top, items } = m;
      const th = edScrollThumb(geo);
      Object.assign(this.track.style, { top: top + 'px', height: geo.trackHeight + 'px' });
      Object.assign(this.thumb.style, { display: th.visible ? '' : 'none', top: th.top + 'px', height: th.height + 'px' });
      this.geo = geo;
      this.items = items;
      this.paint(geo.trackHeight, items);
    }

    paint(h, items) {
      const c = this.ruler;
      const dpr = window.devicePixelRatio || 1;
      c.width = ED_SCROLL_W * dpr;
      c.height = Math.max(0, h) * dpr;
      c.style.height = h + 'px';
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(this.view.dom);
      const half = ED_SCROLL_W / 2;
      for (const it of items) {
        ctx.fillStyle = css.getPropertyValue(it.color).trim();
        if (it.lane === 'full') ctx.fillRect(0, it.y, ED_SCROLL_W, it.h);
        else ctx.fillRect(it.lane === 'left' ? 0 : half, it.y, half, it.h);
      }
    }

    // FR-CMR-74: thumb 를 끌면 스크롤하고, track 을 누르면 thumb 가운데가 그 자리로 온다 (옛 엔진의 `scrollByPage:false`).
    onDown(e) {
      if (e.button !== 0 || !this.geo) return;
      e.preventDefault();
      const geo = edScrollGeo(this.view);
      const th = edScrollThumb(geo);
      if (!th.visible) return;
      const y = e.clientY - this.track.getBoundingClientRect().top;
      if (e.target !== this.thumb) {
        this.view.scrollDOM.scrollTop = edScrollFromThumb(y - th.height / 2, geo);
      }
      this.dragFrom = { y: e.clientY, top: edScrollThumb(edScrollGeo(this.view)).top };
      this.thumb.classList.add('active');
      window.addEventListener('mousemove', this.onMove);
      window.addEventListener('mouseup', this.onUp);
    }

    drag(e) {
      if (!this.dragFrom) return;
      e.preventDefault();
      const geo = edScrollGeo(this.view);
      this.view.scrollDOM.scrollTop = edScrollFromThumb(this.dragFrom.top + e.clientY - this.dragFrom.y, geo);
    }

    stop() {
      this.dragFrom = null;
      this.thumb.classList.remove('active');
      window.removeEventListener('mousemove', this.onMove);
      window.removeEventListener('mouseup', this.onUp);
    }

    destroy() {
      this.stop();
      this.track.remove();
    }
  }, {
    eventHandlers: {
      scroll() { this.view.requestMeasure(this.measure) },
    },
  });
  return edCmScrollbarPlugin.plugin;
}

/** 편집기 칸의 스크롤바·ruler 확장. 브라우저의 세로 스크롤바는 숨기고 그 폭만큼 오른쪽을 비운다. */
function edCmScrollbar() {
  return [
    edCmScrollbarPlugin(),
    CM.EditorView.theme({
      '.cm-scroller': { marginRight: ED_SCROLL_W + 'px' },
      '.cm-scroller::-webkit-scrollbar': { width: '0', height: 'var(--ui-scroll-w)' },
      '.cm-scroller::-webkit-scrollbar-thumb': { background: 'var(--text-dim)', borderRadius: '4px' },
      '.cm-vscroll': { position: 'absolute', right: '0', width: ED_SCROLL_W + 'px', zIndex: 'var(--z-raised)' },
      '.cm-vscroll-ruler': { position: 'absolute', left: '0', top: '0', width: '100%', pointerEvents: 'none' },
      '.cm-vscroll-thumb': {
        position: 'absolute', left: '0', width: '100%',
        background: ED_SCROLL_THUMB_BG,
      },
      '.cm-vscroll-thumb:hover': { background: ED_SCROLL_THUMB_BG_HOVER },
      '.cm-vscroll-thumb.active': { background: ED_SCROLL_THUMB_BG_ACTIVE },
    }),
  ];
}
