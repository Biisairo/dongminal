// 사이드바 리스트 블루프린트 (UX_REVISION_SRS 묶음 B).
//
// 창 목록과 Git 핀 목록은 **같은 것**이다 — 항목이 있고, 클릭하면 열리고, ×로
// 지우고, 끌어서 순서를 바꾼다. 지금까지 그 둘은 각자 reconcile·드래그·행 생성을
// 구현했고(A14), 그래서 한쪽에만 있는 동작이 생겼다: 핀 재배치는 다시 그리기를
// 부르지 않아 3초 폴링까지 옛 순서로 남았다 (A15).
//
// 여기서 구현을 하나로 내린다. 탭은 **타깃만** 다르다 (D-3).
//
// 서술자가 주는 것 (FR-BLP-3): 컨테이너 id · 항목 열거 · 행의 값 · 재배치.
// 블루프린트가 소유하는 것 (FR-BLP-4): reconcile · 드래그 바인딩 · 낙관적 재배치 ·
// 빈 목록 표시.
//
// 클래스 이름은 서술자가 준다 (FR-BLP-6) — `.si`·`.git-repo` 위에 e2e 와 CSS 가
// 서 있고, 그것을 갈아치우는 것은 이 SRS 의 일이 아니다. 공통 클래스(`.sbl-*`)를
// **함께** 붙여 공통 스타일이 설 자리를 만든다 (FR-BLP-7).
//
// 로드 순서 계약: repaint.js(reconcileList) **뒤**, renderer.js **앞**.

const SidebarList = {
  /**
   * 탭 서술자 하나의 목록을 그린다. `def.list` 가 없으면 아무 일도 하지 않는다 —
   * 목록이 없는 탭도 있을 수 있다 (FR-BLP-2 의 "탭 하나 = 서술자 하나").
   */
  paint(app, def) {
    const d = def && def.list;
    if (!d) return;
    const el = document.getElementById(d.containerId);
    if (!el) return;
    // 데이터가 아직 없는 목록(Git 은 첫 응답 전)은 **비우기만** 한다. 빈 안내를
    // 그리면 "없다" 와 "아직 모른다" 가 같은 화면이 된다.
    if (d.ready && !d.ready(app)) { el.innerHTML = ''; return }
    const items = (d.items(app) || []).map(it => d.row(app, it));
    el.classList.toggle('empty', !items.length);
    if (!items.length) {
      // FR-BLP-4: 빈 목록 표시도 블루프린트의 것이다. 문구만 서술자가 준다.
      if (!d.emptyText) { el.innerHTML = ''; return }
      el.innerHTML = '<div class="' + (d.emptyClass || 'sbl-none') + '"></div>';
      el.firstElementChild.textContent = d.emptyText;
      return;
    }
    // FR-RPT-3 / FR-BLP-14: 목록을 비우고 다시 만들지 않는다. 이 함수는 폴링과
    // SSE 로도 불리므로, 요소를 새로 만들면 끌고 있던 항목이 DOM 에서 빠진다.
    reconcileList(el, items, {
      key: r => r.key,
      sig: r => this._sig(r),
      build: r => this._build(app, def, r),
    });
  },

  // 행의 **보이는 값 전부**다 (FR-RPT-2). 서술자가 row() 에 담은 것과 1:1 이므로
  // 목록마다 따로 쓸 필요가 없다 — 그것이 블루프린트로 내린 이득의 절반이다.
  _sig(r) {
    const b = r.badge;
    return [r.name || '', r.title || '', r.cls || '', r.dotCls || '',
      r.active ? 1 : 0, r.attn ? 1 : 0, r.removable ? 1 : 0,
      b ? (b.text + '' + (b.cls || '') + '' + (b.title || '')) : '',
    ].join('');
  },

  _build(app, def, r) {
    const d = def.list;
    const el = document.createElement('div');
    el.className = ['sbl-item', d.itemClass, r.cls, r.active ? 'active' : '', r.attn ? 'attn' : '']
      .filter(Boolean).join(' ');
    if (r.dataset) for (const k in r.dataset) if (r.dataset[k] != null) el.dataset[k] = r.dataset[k];
    if (r.title) el.title = r.title;

    const dot = document.createElement('span');
    dot.className = ['sbl-dot', d.dotClass, r.dotCls].filter(Boolean).join(' ');
    el.appendChild(dot);

    const name = document.createElement('span');
    name.className = ['sbl-name', d.nameClass].filter(Boolean).join(' ');
    name.textContent = r.name || '';
    el.appendChild(name);

    if (r.badge) {
      const g = document.createElement('span');
      g.className = ['sbl-badge', d.badgeClass, r.badge.cls].filter(Boolean).join(' ');
      g.textContent = r.badge.text;
      if (r.badge.title) g.title = r.badge.title;
      el.appendChild(g);
    }

    if (r.removable) {
      const x = document.createElement('span');
      x.className = ['sbl-x', d.xClass].filter(Boolean).join(' ');
      x.textContent = '×';
      x.addEventListener('click', e => { e.stopPropagation(); r.onRemove(app) });
      el.appendChild(x);
    }

    // 열기는 항목 자신이다. × 를 눌렀을 때 열리지 않도록 대상을 가른다 — 창
    // 목록이 쓰던 판정을 그대로 옮겼다.
    if (r.onOpen) {
      el.addEventListener('click', e => {
        if (e.target.classList.contains('sbl-x')) return;
        r.onOpen(app);
      });
    }
    if (r.onRename) {
      name.addEventListener('dblclick', e => { e.stopPropagation(); r.onRename(app, e.target) });
    }
    if (d.reorder) this._bindDrag(app, def, el, r);
    return el;
  },

  /**
   * FR-BLP-10·13: 재배치 제스처. 두 목록이 **같은 규약**을 쓴다 —
   * drop(즉시) 1순위, dragend 는 시각 정리만, `done` 으로 중복 커밋을 막는다.
   *
   * 항목 밖에서 놓는 경우는 문서 전역 drop 이 받는다 (input-binding.js). 그쪽도
   * 여기 `commit` 을 부르므로 경로가 갈라지지 않는다.
   */
  _bindDrag(app, def, el, r) {
    const d = def.list;
    const list = document.getElementById(d.containerId);
    const clear = () => list && list.querySelectorAll('.sbl-item').forEach(x =>
      x.classList.remove('drag-above', 'drag-below'));
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      app._drag = { type: d.reorder.type, src: r.key, target: null, before: false, done: false };
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('dragging'), 0);
    });
    el.addEventListener('dragover', e => {
      const dr = app._drag; if (!dr || dr.type !== d.reorder.type) return;
      e.preventDefault(); clear();
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      dr.target = r.key; dr.before = before;
      el.classList.add(before ? 'drag-above' : 'drag-below');
    });
    el.addEventListener('drop', e => {
      const dr = app._drag; if (!dr || dr.type !== d.reorder.type) return;
      e.preventDefault(); e.stopPropagation(); clear();
      SidebarList.commit(app, def, dr);
    });
    el.addEventListener('dragend', () => {
      app._drag = null; el.classList.remove('dragging'); clear();
    });
  },

  /**
   * FR-BLP-10~12: 재배치를 확정한다.
   *
   * **놓는 즉시 로컬에 반영하고 그린다.** 서버 확정이 있는 목록은 그 뒤에
   * 비동기로 커밋하고, 실패하면 서버가 준 순서로 되돌린다 — 화면이 거짓 순서로
   * 남지 않는다. 이 순서가 A15 의 딜레이를 없앤다: 지금까지 핀 목록은 서버 왕복이
   * 끝나고도 다시 그려지지 않아 폴링(3초)을 기다렸다.
   */
  commit(app, def, dr) {
    const d = def && def.list;
    if (!d || !d.reorder) return;
    if (!dr || dr.done || !dr.src || !dr.target || dr.src === dr.target) return;
    dr.done = true;
    if (!d.reorder.apply(app, dr)) return;
    d.reorder.repaint ? d.reorder.repaint(app) : app.render();
    if (d.reorder.commit) d.reorder.commit(app, dr);
  },

  // 서술자 배열 전체에서 이 드래그 타입을 가진 탭을 찾는다. 문서 전역 drop 이
  // 쓴다 — 그쪽은 어느 탭의 드래그인지 타입 문자열로만 안다.
  defByDragType(type) {
    return SB_TAB_DEFS.find(d => d.list && d.list.reorder && d.list.reorder.type === type) || null;
  },

  /**
   * FR-BLP-9: 패널의 액션 버튼 행. 서술자가 준 목록에서 그린다 — 버튼이 목록
   * **위**에 오는 것은 두 패널이 공유하는 골격이다 (FR-BLP-5·8).
   *
   * 버튼 요소는 index.html 에 정적으로 있다. 여기서는 자리와 순서만 맞춘다 —
   * 만들어 넣으면 id 로 잡는 기존 배선(app-git._initGitSection 등)이 끊긴다.
   */
  layoutActions(def) {
    const d = def && def.list;
    if (!d || !d.actions || !d.actions.length) return;
    const panel = document.getElementById(def.panelId);
    const listEl = document.getElementById(d.containerId);
    if (!panel || !listEl) return;
    let bar = panel.querySelector('.sb-actions');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sb-actions';
      panel.insertBefore(bar, panel.firstChild);
    }
    for (const id of d.actions) {
      const b = document.getElementById(id);
      if (b && b.parentElement !== bar) bar.appendChild(b);
    }
    if (listEl.previousElementSibling !== bar) panel.insertBefore(bar, listEl);
  },
};
