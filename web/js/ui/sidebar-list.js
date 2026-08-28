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
   * EDITOR_TAB_SRS FR-EDT-2·6·14: 목록의 항목 = `items(app)` **뒤에** `fixed(app)`.
   *
   * 고정 항목은 같은 컨테이너의 마지막에 그려지고(FR-EDT-14) 순회에도 마지막
   * 자리로 포함된다(FR-EDT-6) — 제외하면 키만으로는 그 항목에 갈 수 없다.
   * 그리기와 순회가 **같은 함수**를 지나야 둘이 어긋나지 않는다.
   */
  entries(app, d) {
    const base = (d.items ? d.items(app) : null) || [];
    if (!d.fixed) return base;
    return base.concat(d.fixed(app) || []);
  },

  /**
   * 탭 서술자 하나의 목록을 그린다. `def.list` 가 없으면 아무 일도 하지 않는다 —
   * 목록이 없는 탭도 있을 수 있다 (FR-BLP-2 의 "탭 하나 = 서술자 하나").
   */
  paint(app, def) {
    const d = def && def.list;
    if (!d) return;
    this._paintInto(app, def, d.containerId, (d.items ? d.items(app) : null) || [], true);
    // FR-EDT-14: 고정 항목(root 행)은 **패널의 최하단**에 산다 — 목록의 끝이
    // 아니다. 목록이 길어 스크롤이 생겨도 그 아래에 그대로 남아야 하므로 컨테이너를
    // 따로 쓴다. 순회(cycle)는 여전히 `entries()` 하나를 지나므로 둘의 순서가
    // 어긋나지 않는다.
    if (d.fixedContainerId)
      this._paintInto(app, def, d.fixedContainerId, (d.fixed ? d.fixed(app) : null) || [], false);
  },

  // `main` 은 "빈 안내와 ready 게이트를 지는 쪽" 이다. 고정 항목은 없을 수 있고
  // 그때는 비어 있는 것이 정상이라 안내를 그리지 않는다.
  _paintInto(app, def, containerId, source, main) {
    const d = def.list;
    const el = document.getElementById(containerId);
    if (!el) return;
    // FR-BLP-7: 컨테이너의 생김새(남은 높이 전부 + 세로 스크롤)도 공통이다.
    el.classList.add('sbl-list');
    // 데이터가 아직 없는 목록(Git 은 첫 응답 전)은 **비우기만** 한다. 빈 안내를
    // 그리면 "없다" 와 "아직 모른다" 가 같은 화면이 된다.
    if (d.ready && !d.ready(app)) { el.innerHTML = ''; return }
    if (!main) {
      el.classList.remove('sbl-list');
      el.classList.add('sbl-fixed');
    }
    // 키는 서술자 최상위에 있다 — reconcile 과 순회(cycle)가 **같은 키**를 봐야
    // 하기 때문이다. 행 안에 두면 순회가 그 값을 얻으려고 행을 만들어야 한다.
    const items = source.map(it => Object.assign({ key: d.key(it) }, d.row(app, it)));
    el.classList.toggle('empty', !items.length);
    if (!items.length) {
      // FR-BLP-4: 빈 목록 표시도 블루프린트의 것이다. 문구만 서술자가 준다.
      if (!main || !d.emptyText) { el.innerHTML = ''; return }
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
    // FR-EDT-15: 고정 항목은 재배치의 출발점도 **대상**도 아니다. 리스너를 아예
    // 달지 않으면 둘 다 성립한다 — 대상은 dragover 가 정하기 때문이다.
    if (d.reorder && !r.fixed) this._bindDrag(app, def, el, r);
    if (d.tabDrop) this._bindTabDrop(app, def, el, r);
    return el;
  },

  /**
   * FR-MOV-1·7: 항목이 **탭을 받는다.**
   *
   * 재배치(`_bindDrag`)와 다른 제스처다 — 저쪽은 목록 안에서 순서를 바꾸고,
   * 이쪽은 바깥(분할 칸의 탭 바)에서 온 것을 받는다. 그래서 표식도 다르다:
   * 위/아래 선이 아니라 테두리(`drop-into`)로 "이 안으로" 를 말한다.
   *
   * 받을지 말지는 서술자가 정한다 — 창 목록만 탭을 받고, 리포 목록은 받지 않는다.
   */
  _bindTabDrop(app, def, el, r) {
    const d = def.list;
    const list = document.getElementById(d.containerId);
    const clear = () => list && list.querySelectorAll('.sbl-item').forEach(x =>
      x.classList.remove('drop-into'));
    el.addEventListener('dragover', e => {
      const dr = app._drag; if (!dr || dr.type !== 'tab') return;
      if (!d.tabDrop.accepts(app, r)) return;
      e.preventDefault(); e.stopPropagation();
      clear(); el.classList.add('drop-into');
    });
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-into');
    });
    el.addEventListener('drop', e => {
      const dr = app._drag; if (!dr || dr.type !== 'tab') return;
      if (!d.tabDrop.accepts(app, r)) return;
      e.preventDefault(); e.stopPropagation();
      clear(); app._drag = null;
      d.tabDrop.drop(app, r, dr);
    });
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
      app._drag = null; el.classList.remove('dragging', 'drop-into'); clear();
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
    // apply 는 **로컬 순서만** 바꾼다. 영속은 commit 이 한다 — 창은 워크스페이스에
    // 쓰고 핀은 서버를 지난다 (FR-GIT-223). 두 목록의 구조가 같고 타깃만 다르다.
    if (!d.reorder.apply(app, dr)) return;
    // 바뀐 것은 이 목록의 순서뿐이다 — 전체를 다시 그리면 터미널이 재부착된다.
    this.paint(app, def);
    if (d.reorder.commit) d.reorder.commit(app, dr);
  },

  /**
   * UX_REVISION_SRS FR-BLP-15~18: 목록 순회. **두 목록이 같은 규약을 쓴다.**
   *
   * 규약은 창 순회가 세운 것 그대로다.
   *   ① 목록이 비면 아무 일도 하지 않는다
   *   ② 지금 있는 곳이 목록 **밖**이면 첫 항목으로 들어간다 — 순회 키가 막다른
   *      길이 되지 않는다 (FR-GIT-184 가 창에 대해 세운 것)
   *   ③ 항목이 하나뿐이면 아무 일도 하지 않는다
   *   ④ 끝에서 감싼다
   *
   * 지금까지 `_cycleWindow` 와 `_gitCycleRepo` 가 이 규약을 각자 구현했고, 그래서
   * ②가 한쪽에만 있었다 — 핀이 하나인데 그 리포를 보고 있지 않으면 Git 쪽은
   * 아무 일도 하지 않았다. 창 쪽이라면 그 하나로 들어갔을 상황이다.
   */
  cycle(app, def, step) {
    const d = def && def.list;
    const c = d && d.cycle;
    if (!c) return;
    let arr = this.entries(app, d);
    // 순회 대상이 목록보다 좁을 수 있다 — Git 은 저장소가 아닌 핀을 뺀다
    // (FR-GIT-11: 목록에서도 클릭 리스너가 붙지 않는 항목이다).
    if (c.filter) arr = arr.filter(c.filter);
    if (!arr.length) return;
    const cur = c.currentKey(app);
    const i = arr.findIndex(it => d.key(it) === cur);
    if (i < 0) { c.open(app, arr[0]); return }
    if (arr.length < 2) return;
    c.open(app, arr[(i + step + arr.length) % arr.length]);
  },

  // 서술자 배열 전체에서 이 드래그 타입을 가진 탭을 찾는다. 문서 전역 drop 이
  // 쓴다 — 그쪽은 어느 탭의 드래그인지 타입 문자열로만 안다.
  defByDragType(type) {
    return SB_TAB_DEFS.find(d => d.list && d.list.reorder && d.list.reorder.type === type) || null;
  },
};
