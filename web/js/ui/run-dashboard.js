/**
 * Run 대시보드 — 요약·그래프(노드·호)·카드·타임라인과 표기 (FR-RVZ-10~13).
 * `runs-panel.js` 의 증강 분할이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-4 · FEU-23) — 목록·확인·탭은
 * 그쪽에 남고, 계약은 `RunsPanel` 한 클래스에 남는다. 치수 상수(`RUN_*`)와 `runSvg`·`runDiv` 는
 * `runs-panel.js` 가 갖는다.
 */
Object.assign(RunsPanel.prototype, {
  // ── 대시보드 (FR-RVZ-10~13) ──

  _runPaint(v) {
    const miss = v.root.querySelector('.run-miss');
    const body = v.root.querySelector('.run-body');
    // FR-RVZ-9: 사라진 Run 은 그렇게 말하고 만다. 탭은 자동으로 닫지 않는다 —
    // 사용자가 만든 것은 사용자가 닫는다.
    const gone = v.err === 'gone';
    const failed = !!v.err && !gone;
    const note = gone ? RUN_GONE_TEXT : failed ? v.err : '';
    paintIfChanged(miss, note, () => { miss.textContent = note });
    miss.classList.toggle('vis', !!note);
    miss.classList.toggle('err', failed);
    body.classList.toggle('vis', !note && !!v.data);
    if (note || !v.data) return;

    const d = v.data;
    const members = d.members || [];
    const pos = this._runLayout(members.length);
    this._runPaintSummary(v.root, d, members);
    this._runPaintGraph(v.root, d, members, pos);
    this._runPaintCards(v.root, d, members);
    this._runPaintTimeline(v.root, d);
    this._runScheduleDecay(v, d);
  },

  // "최근 30초" 는 시각의 함수이므로 마지막 이벤트만으로는 꺼지지 않는다.
  // 만료 시점에 **다시 그리기만** 예약한다 — 요청은 나가지 않으므로 폴링이
  // 아니다 (V-RVZ-4 는 요청 건수를 센다).
  _runScheduleDecay(v, d) {
    if (v.decay) { TIMERS.cancel(v.decay); v.decay = null }
    const now = Date.now() / 1000;
    let soonest = Infinity;
    for (const e of d.edges || []) {
      // 경계가 닫힌 구간(<=)이므로 left === 0 도 아직 강조 중이다 — 여기서
      // 빠뜨리면 그 엣지의 강조를 꺼 줄 사람이 아무도 없다.
      const left = RUN_RECENT_SEC - (now - (e.lastAt || 0));
      if (left >= 0 && left < soonest) soonest = left;
    }
    if (soonest === Infinity) return;
    v.decay = TIMERS.after(Math.ceil(soonest * 1000) + 50, () => {
      v.decay = null;
      if (this._runViewMap().get(v.key) === v) this._runPaint(v);
    }, {owner:this,label:'run-decay'});
  },

  // FR-RVZ-10: 요약. 도해의 `패턴` 행은 그리지 않는다 — Run 레코드에 패턴 필드가
  // 없고, 시각화에만 있는 정보를 만들지 않는다 (NFR-RVZ-4, SRS §3.5.3 판정).
  _runPaintSummary(root, d, members) {
    const el = root.querySelector('.run-summary');
    const headless = members.filter(m => m.headless).length;
    const parts = [
      ['short', 'Run ' + (d.short || runShortId(d.runId || ''))],
      ['obj', d.objective ? t('runs.objective', { v: d.objective }) : ''],
      ['state', 'state=' + (d.state || '')],
      ['iso', 'isolation=' + (d.isolation || 'none')],
      ['ago', t('runs.elapsed', { ago: this._runAgo(d.createdAt) })],
      ['members', headless ? t('runs.member_count_headless', { n: members.length, h: headless }) : t('runs.member_count', { n: members.length })],
    ].filter(p => p[1]);
    paintIfChanged(el, parts.map(p => p[1]).join('|'), () => {
      el.innerHTML = '';
      for (const [cls, text] of parts) el.appendChild(runDiv('run-sum-' + cls, text));
    });
  },

  // FR-RVZ-11: 계층형 고정 배치. 조정자가 최상단, 멤버는 그 아래 한 줄에 균등.
  // 멤버 수만으로 결정되므로 같은 Run 은 볼 때마다 같은 자리에 온다.
  _runLayout(n) {
    const w = Math.max(RUN_MIN_W, n * (RUN_NODE_W + RUN_NODE_GAP_X) + RUN_GRAPH_PAD_X);
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(Math.round(w * (i + 1) / (n + 1)));
    // 멤버가 없으면 멤버 줄도 그 아래 호 자리도 필요 없다 — 빈 띠를 남기면
    // 대시보드가 덜 그려진 것처럼 보인다.
    const h = n ? RUN_ROW_Y + RUN_NODE_H + RUN_GRAPH_PAD_BOTTOM : RUN_COORD_Y + RUN_NODE_H + RUN_GRAPH_PAD_COORD;
    return { w, h, cx: Math.round(w / 2), xs };
  },

  _runPaintGraph(root, d, members, pos) {
    const svg = root.querySelector('.run-graph');
    // FR-FIT-5: viewBox 는 배치 좌표 그대로다 — 같은 Run 은 어디서 봐도 같은
    // 모양이며, 맞춤은 **표시 크기**만 건드린다.
    svg.setAttribute('viewBox', `0 0 ${pos.w} ${pos.h}`);
    svg.dataset.w = pos.w;
    svg.dataset.h = pos.h;
    this._runFitGraph(root);
    this._runDefs(svg);

    const at = new Map(); // 노드 id → 중심 x
    at.set(RUN_COORD, pos.cx);
    members.forEach((m, i) => at.set(m.id, pos.xs[i]));

    this._runPaintEdges(root, d, members, at);
    this._runPaintNodes(root, d, members, at);
  },

  /**
   * FR-FIT-1~4: 그래프를 감싼 칸의 폭에 맞춘다.
   *
   * 배율은 [RUN_FIT_MIN, RUN_FIT_MAX] 로 잘린다 — 좁으면 줄이되 읽을 수 있는
   * 데까지만(그 아래는 가로 스크롤), 넓으면 키우되 표지가 되지 않을 만큼만.
   *
   * 폭을 재는 대상은 wrap 이며, 그 값이 0 이면(아직 붙지 않은 DOM) 아무것도
   * 하지 않는다 — 0 으로 나눈 배율은 그래프를 사라지게 한다.
   */
  _runFitGraph(root) {
    const wrap = root.querySelector('.run-graph-wrap');
    const svg = root.querySelector('.run-graph');
    if (!wrap || !svg) return;
    const w = Number(svg.dataset.w || 0), h = Number(svg.dataset.h || 0);
    if (!w || !h) return;
    // 좌우 여백은 wrap 의 padding 이다. clientWidth 는 그것을 포함하므로 뺀다.
    const cs = getComputedStyle(wrap);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const avail = wrap.clientWidth - pad;
    if (avail <= 0) return;
    const scale = Math.min(RUN_FIT_MAX, Math.max(RUN_FIT_MIN, avail / w));
    svg.setAttribute('width', Math.round(w * scale));
    svg.setAttribute('height', Math.round(h * scale));
  },

  // FR-FIT-6: 분할 칸이 바뀌면 다시 맞춘다. 폴링하지 않는다 — 크기 변화는
  // 관측 가능한 사건이며, 대시보드가 그것을 물어볼 이유가 없다.
  _runObserveFit(v) {
    if (v.ro || typeof ResizeObserver === 'undefined') return;
    const wrap = v.root.querySelector('.run-graph-wrap');
    if (!wrap) return;
    v.ro = new ResizeObserver(() => this._runFitGraph(v.root));
    v.ro.observe(wrap);
  },

  // 화살촉. 색은 CSS 가 채운다 — 마커 안에서는 테마 변수를 클래스로만 만난다.
  // id 는 문서 전역이므로 이 svg 에서만 쓰는 접미사를 붙인다 (여러 분할 칸이
  // 각자 Run 탭을 띄울 수 있다).
  _runDefs(svg) {
    const defs = svg.querySelector('defs');
    if (defs.childElementCount) return;
    if (!this._runDefsSeq) this._runDefsSeq = 0;
    const sfx = 'r' + (++this._runDefsSeq);
    svg.dataset.mk = sfx;
    for (const kind of ['msg', 'recent', 'succ']) {
      const mk = runSvg('marker', {
        id: 'rm-' + sfx + '-' + kind, class: 'run-mk run-mk-' + kind,
        viewBox: '0 0 8 8', refX: '7', refY: '4',
        markerWidth: '6', markerHeight: '6', orient: 'auto',
      });
      mk.appendChild(runSvg('path', { d: 'M0,0 L8,4 L0,8 z' }));
      defs.appendChild(mk);
    }
  },

  // FR-RVZ-12: 메시지 흐름 = 굵기(로그 스케일) + 방향 화살표 + 최근 30초 강조.
  // 승계는 그와 별개의 굵은 화살표다 (V-RVZ-7).
  _runPaintEdges(root, d, members, at) {
    const g = root.querySelector('.run-edges');
    const sfx = root.querySelector('.run-graph').dataset.mk;
    const now = Date.now() / 1000;
    const rowIdx = new Map(); members.forEach((m, i) => rowIdx.set(m.id, i));
    const items = [];

    for (const e of d.edges || []) {
      // 끝점이 이 Run 의 멤버가 아닐 수 있다 — 팀 간 통신이면 다른 Run 의 멤버
      // uuid 가 온다. 무명 노드를 세우지 않고 건너뛴다: 이 화면은 **이 Run 의**
      // 관계도이며, 이름도 상태도 모르는 상자를 세우면 그것이 더 큰 거짓이다.
      if (!at.has(e.from) || !at.has(e.to)) continue;
      const recent = (now - (e.lastAt || 0)) <= RUN_RECENT_SEC;
      items.push({ kind: 'msg', from: e.from, to: e.to, count: e.count || 0, recent });
    }
    // 승계 관계는 멤버 레코드에서 온다 — 메시지가 아니므로 엣지 목록에 없다.
    for (const m of members) {
      if (m.succeededFrom && at.has(m.succeededFrom)) items.push({ kind: 'succ', from: m.succeededFrom, to: m.id });
    }

    reconcileList(g, items, {
      key: it => it.kind + ':' + it.from + '>' + it.to,
      sig: it => it.kind + ':' + it.count + ':' + (it.recent ? 1 : 0) + ':' + at.get(it.from) + ':' + at.get(it.to),
      build: it => this._runEdgeEl(it, at, rowIdx, sfx),
    });
  },

  _runEdgeEl(it, at, rowIdx, sfx) {
    const x1 = at.get(it.from), x2 = at.get(it.to);
    const cls = ['run-edge', 'run-edge-' + it.kind];
    if (it.recent) cls.push('recent');
    let d, mk;
    if (it.kind === 'succ') {
      // 승계는 멤버 줄 **위쪽** 호다. 메시지 호(아래쪽)와 자리가 겹치지 않아야
      // 굵기만으로 구분하지 않아도 읽힌다.
      d = `M${x1},${RUN_ROW_Y} Q${(x1 + x2) / 2},${RUN_ROW_Y - 46} ${x2},${RUN_ROW_Y}`;
      mk = 'succ';
    } else if (it.from === RUN_COORD || it.to === RUN_COORD) {
      // 조정자와의 통신은 직선이다. 두 방향이 같은 선 위에 겹치지 않도록
      // 방향마다 조금 어긋나게 둔다.
      const off = it.from === RUN_COORD ? -5 : 5;
      const mx = it.from === RUN_COORD ? x2 : x1;
      d = it.from === RUN_COORD
        ? `M${at.get(RUN_COORD) + off},${RUN_COORD_Y + RUN_NODE_H} L${mx + off},${RUN_ROW_Y}`
        : `M${mx + off},${RUN_ROW_Y} L${at.get(RUN_COORD) + off},${RUN_COORD_Y + RUN_NODE_H}`;
      mk = it.recent ? 'recent' : 'msg';
    } else {
      // 멤버끼리는 호다. 떨어진 만큼 더 깊게 내려 서로 포개지지 않게 한다.
      const gap = Math.abs((rowIdx.get(it.from) || 0) - (rowIdx.get(it.to) || 0));
      const dip = RUN_ROW_Y + RUN_NODE_H + 24 + gap * 14;
      d = `M${x1},${RUN_ROW_Y + RUN_NODE_H} Q${(x1 + x2) / 2},${dip} ${x2},${RUN_ROW_Y + RUN_NODE_H}`;
      mk = it.recent ? 'recent' : 'msg';
    }
    const p = runSvg('path', { class: cls.join(' '), d, 'marker-end': `url(#rm-${sfx}-${mk})` });
    if (it.kind !== 'succ') {
      // 굵기 = 건수의 로그 스케일. 선형이면 한 쌍이 나머지를 전부 눌러 버린다.
      // 상한은 승계 화살표(CSS 5)보다 낮게 둔다 — 겹치면 "굵은 화살표"가
      // 승계를 가리키는지 수다스러운 한 쌍을 가리키는지 알 수 없게 된다.
      p.setAttribute('stroke-width', String(Math.min(4, 1 + 0.6 * Math.log2(1 + it.count))));
      // count 는 **보관된 메시지** 기준이다 — Run 당 최근 500건 상한(FR-RVZ-14)에
      // 걸려 잘려 나간 건은 빠진다. "총 통신 횟수" 로 읽히면 안 된다.
      const title = runSvg('title');
      title.textContent = tn('runs.archived_msgs', it.count);
      p.appendChild(title);
    }
    return p;
  },

  // FR-RVZ-12: 상태=테두리 색, 헤드리스=점선, 컨텍스트=하단 게이지.
  _runPaintNodes(root, d, members, at) {
    const g = root.querySelector('.run-nodes');
    /**
     * FR-RCX-9: 조정자 노드도 **자기 관측을 싣는다.**
     *
     * 이 노드는 멤버가 아니라 합성된 가상 노드이고(D-13), 관측은 Run 레코드의
     * 전용 필드에 산다. 여기서 그것을 얹으면 아래 게이지·숫자 코드가 멤버와
     * **같은 갈래**를 지난다 — 조정자만 다른 규칙으로 그리면 색과 숫자가 두
     * 벌이 된다.
     */
    const items = [Object.assign(
      { id: RUN_COORD, role: t('runs.coordinator'), agent: '', state: '', coord: true },
      d.coordinator || {})];
    for (const m of members) items.push(m);
    reconcileList(g, items, {
      key: it => it.id,
      // FR-RPT-2: 보이는 값 전부다. 퍼센트가 글자로 나왔으므로 그것도 여기 든다.
      sig: it => [it.coord ? 'c' : 'm', it.role, it.agent, it.state, it.headless ? 1 : 0,
        it.contextLevel || '', Math.round((it.contextRatio || 0) * 100), at.get(it.id)].join(':'),
      build: it => this._runNodeEl(it, at.get(it.id)),
    });
  },

  _runNodeEl(m, cx) {
    const y = m.coord ? RUN_COORD_Y : RUN_ROW_Y;
    const x = cx - RUN_NODE_W / 2;
    const cls = ['run-node'];
    if (m.coord) cls.push('coord'); else cls.push('state-' + (m.state || 'starting'));
    // V-RVZ-5: 헤드리스는 점선 테두리다. 상태가 succeeded 일 때도 점선이지만
    // 클래스가 다르므로 둘을 섞어 세지 않는다.
    if (m.headless) cls.push('headless');
    const g = runSvg('g', { class: cls.join(' ') });
    g.dataset.node = m.id;

    const title = runSvg('title');
    title.textContent = m.coord ? t('runs.coordinator')
      : [m.role, m.agent, m.state, m.headless ? t('runs.headless') : ''].filter(Boolean).join(' · ');
    g.appendChild(title);

    g.appendChild(runSvg('rect', {
      class: 'run-node-box', x, y, width: RUN_NODE_W, height: RUN_NODE_H, rx: 5,
    }));
    const role = runSvg('text', { class: 'run-node-role', x: cx, y: y + 21, 'text-anchor': 'middle' });
    role.textContent = m.role || (m.coord ? t('runs.coordinator') : t('runs.no_role_paren'));
    g.appendChild(role);
    const sub = runSvg('text', { class: 'run-node-sub', x: cx, y: y + 36, 'text-anchor': 'middle' });
    sub.textContent = m.coord ? '' : [m.agent, m.state].filter(Boolean).join(' · ');
    g.appendChild(sub);

    /**
     * V-RVZ-6: 컨텍스트 게이지. `contextLevel` 이 비면 "모른다" 이므로 그리지
     * 않는다 — ok 로 칠하면 없는 관측을 있다고 말하는 것이 된다 (FR-CBG-5).
     *
     * FR-RCX-9: **`!m.coord` 제약이 사라졌다.** 조정자에게 관측이 없어서 뺐던
     * 것이고, 이제 있다 (FR-RCX-6). 값이 없으면 `contextLevel` 이 비므로 이
     * 조건 하나가 두 경우를 다 가른다.
     */
    if (m.contextLevel) {
      const gw = RUN_NODE_W - 16;
      g.appendChild(runSvg('rect', {
        class: 'run-gauge-bg', x: x + 8, y: y + RUN_NODE_H - 9, width: gw, height: 4, rx: 2,
      }));
      g.appendChild(runSvg('rect', {
        class: 'run-gauge lv-' + m.contextLevel, x: x + 8, y: y + RUN_NODE_H - 9,
        width: Math.max(2, Math.round(gw * Math.min(1, m.contextRatio || 0))), height: 4, rx: 2,
      }));
      // FR-RCX-4: 게이지 옆에 **숫자**도 적는다. 4px 막대만으로는 "얼마나" 를
      // 읽을 수 없다 — 접수한 말("run 의 context 표기")이 그것이다.
      const pct = runSvg('text', {
        class: 'run-node-ctx lv-' + m.contextLevel, x: cx, y: y + RUN_NODE_H - 13,
        'text-anchor': 'middle',
      });
      pct.textContent = Math.round((m.contextRatio || 0) * 100) + '%';
      g.appendChild(pct);
    }
    return g;
  },

  // FR-RVZ-10: 멤버 카드. FR-RVZ-13: 클릭하면 그 멤버의 도구로 포커스가 점프한다.
  _runPaintCards(root, d, members) {
    const el = root.querySelector('.run-cards');
    reconcileList(el, members, {
      key: m => m.id,
      // FUI-04: `분리` 버튼의 유무가 `tabId` 로 갈린다 — 근거에 넣지 않으면
      // 부착·분리 뒤 버튼이 따라오지 않는다 (FR-RPT-2).
      sig: m => [m.role, m.agent, m.state, m.headless ? 1 : 0, m.contextLevel || '',
        Math.round((m.contextRatio || 0) * 100), m.compactCount || 0,
        m.contextTokens || 0, m.contextLimit || 0,
        (m.worktree && m.worktree.branch) || '', m.succeededBy || '',
        m.tabId ? 1 : 0, this._runDetachErr === m.id ? 1 : 0].join(':'),
      build: m => this._runCardEl(m),
    });
  },

  _runCardEl(m) {
    const card = runDiv('run-card state-' + (m.state || 'starting'));
    card.dataset.member = m.id;
    if (m.headless) card.classList.add('headless');
    card.appendChild(runDiv('run-card-role', '[' + (m.role || t('runs.no_role')) + ']'));
    if (m.agent) card.appendChild(runDiv('run-card-agent', m.agent));
    card.appendChild(runDiv('run-card-state', m.state || ''));
    if (m.contextLevel) {
      const pct = Math.round((m.contextRatio || 0) * 100);
      const warn = m.contextLevel === 'ok' ? '' : ' ⚠';
      /**
       * FR-RCX-1: **숫자가 본문으로 나온다.**
       *
       * UX_BATCH6_SRS FR-CTX-8 이 "무엇을 무엇으로 나눈 값인지 말한다" 를 세웠고
       * 그 답을 툴팁에 두었는데, 툴팁은 마우스를 올려야 보이고 터치에는 없다.
       * 접수한 말("run 의 context 표기")이 그 자리를 본문으로 옮기라는 것이다.
       *
       * FR-RCX-2: 실측 토큰이 없어 바이트 추정으로 낸 값은 `~` 로 남는다 —
       * 추정과 실측을 같은 얼굴로 보이면 안 된다 (NFR-CBG-3). 실측이 있으면
       * 그 물결이 사라지고 대신 토큰 수가 선다.
       */
      const measured = m.contextTokens && m.contextLimit;
      const text = measured
        ? `${this._runTokens(m.contextTokens)} / ${this._runTokens(m.contextLimit)} · ${pct}%${warn}`
        : `ctx ~${pct}%${warn}`;
      card.appendChild(runDiv('run-card-ctx lv-' + m.contextLevel, text));
    }
    if (m.compactCount) card.appendChild(runDiv('run-card-compact', tn('runs.compact_count', m.compactCount)));
    if (m.worktree && m.worktree.branch) card.appendChild(runDiv('run-card-wt', 'wt: ' + m.worktree.branch));
    if (m.headless) card.appendChild(runDiv('run-card-headless', t('runs.headless_paren')));
    card.title = m.headless
      ? t('runs.card_attach_title')
      : t('runs.card_jump_title');
    card.addEventListener('click', () => this._runJumpToMember(m));
    /**
     * `12-func-ui.md FUI-04`: **분리.** 탭은 닫히고 도구는 산다.
     *
     *   이전 동작: 부착(`attach`)만 화면에 있었다. 붙인 뒤 자리를 비우려면 탭을
     *             직접 닫아야 했고, 그것은 **도구를 종료하는 길**과 같은 동작이라
     *             사용자가 무엇이 일어나는지 알 수 없었다
     *   새  동작: `POST /api/runs/detach` 를 부르는 버튼이 카드에 선다
     *   이유:     서버는 이 종단을 이미 갖고 있었다 (FR-HLM-7) — 없던 것은
     *             화면뿐이다
     *
     * **붙어 있는 멤버에만** 둔다 — 서버가 `member_not_attached` 로 거절하는
     * 조합을 누를 수 있게 보이면 그 버튼은 거짓말이다.
     */
    // 실패는 버튼보다 **앞**에 둔다 — 오른쪽 끝(`margin-left:auto`)이 버튼의
    // 자리이고, 사유가 그 뒤에 붙으면 카드마다 끝이 흔들린다 (FR-BGK-10 과
    // 같은 자리, `runs-err-inline` 이 삭제 목표 앞에 서는 것과 같은 규약).
    if (this._runDetachErr === m.id && this._runDetachMsg) {
      card.appendChild(runDiv('run-card-err', this._runDetachMsg));
    }
    if (m.tabId) card.appendChild(this._runDetachBtn(m));
    return card;
  },

  _runDetachBtn(m) {
    const btn = document.createElement('button');
    btn.className = 'ui-btn ui-btn-sm run-card-detach'; btn.textContent = t('runs.detach');
    btn.title = TIP_RUNS_DETACH;
    btn.dataset.member = m.id;
    // 카드 클릭은 "그 도구로 간다" 이므로 여기서 멈춘다 — 분리하려는 손이
    // 그 도구로 끌려가면 무엇이 일어났는지 읽히지 않는다.
    btn.addEventListener('click', e => { e.stopPropagation(); this._runDetachMember(m) });
    return btn;
  },

  /**
   * FUI-04 / FR-HLM-7: 분리 한 번.
   *
   * 실패를 **그 카드에** 남긴다 (FR-DEL-6 과 같은 규약) — 분리는 브라우저가
   * 탭을 닫아 주어야 끝나므로 실패할 수 있고(구독 없음·시한 초과), 조용히
   * 넘기면 사용자는 눌리지 않았다고 읽는다.
   */
  async _runDetachMember(m) {
    if (!m || !m.id) return;
    this._runDetachErr = null; this._runDetachMsg = '';
    const r = await apiPost(RUNS_DETACH_API, { memberId: m.id });
    if (!r.ok) { this._runCardFail(m, r, t('runs.detach_fail')); return }
    // 이 멤버를 보고 있는 대시보드 탭들이 결과를 따라온다. 분리는 서버의 사실을
    // 바꾸므로 `run_changed` 가 오지만, **실패한 경우에는 오지 않는다** — 그
    // 안내는 이 다시 그리기가 낸다.
    this._runRefreshViewsOf(m.runId);
  },

  // FUI-04: 그 Run 의 열린 대시보드 탭만 다시 받는다. 열린 탭이 없으면 요청이
  // 나가지 않는다 (V-RVZ-4 가 요청 건수를 센다).
  _runRefreshViewsOf(runId) {
    for (const v of this._runViewMap().values()) {
      if (!runId || v.runId === runId) this._runFetch(v);
    }
  },

  // FR-RVZ-13: 이미 탭이 있으면 그리로 간다. 없으면(헤드리스) 부착이며,
  // 그 결과는 `run attach` 와 같다 — 서버가 restoreTool 을 방송하고 브라우저가
  // 현재 포커스 분할 칸에 새 탭을 만든다 (FR-HLM-6).
  async _runJumpToMember(m) {
    if (!m || !m.id) return;
    if (m.toolId && this.app.findToolLocation(m.toolId)) { this.app.jumpToTool(m.toolId); return }
    try {
      // location 을 비워 둔다 — 그래야 지금 포커스된 분할 칸이 대상이 된다.
      const r = await apiPost(RUNS_ATTACH_API, { memberId: m.id });
      /**
       * `12-func-ui.md FUI-20`: **실패를 카드가 말한다.**
       *
       *   이전 동작: `console.warn` 만. 카드의 툴팁은 "클릭하면 … 부착한다" 고
       *             약속하는데, 실패하면 화면이 조용했다
       *   새  동작: 그 카드 안에 사유를 남긴다 — 분리 실패와 **같은 자리**다
       *   이유:     약속한 동작이 듣지 않으면 사용자는 같은 것을 되풀이해 누른다
       */
      if (!r.ok) {
        console.warn('[run] attach 실패', r.status, r.text.trim());
        this._runCardFail(m, r, t('runs.attach_fail'));
      }
    } catch (e) {
      console.warn('[run] attach 실패', e);
      this._runCardFail(m, null, t('runs.attach_fail'));
    }
  },

  /**
   * 멤버 카드 하나에 실패 사유를 남긴다 (FUI-20·04).
   *
   * 부착과 분리가 **같은 자리**를 쓴다 — 두 실패가 다른 모양이면 사용자가
   * 어느 쪽이 무엇인지 매번 다시 읽는다 (`runs-err-inline` 과 같은 규약).
   */
  _runCardFail(m, r, what) {
    this._runDetachErr = m.id;
    this._runDetachMsg = apiErrText(r, what);
    this._runRefreshViewsOf(m.runId);
  },

  // FR-RVZ-10: 타임라인. 서버가 준 순서를 그대로 쓴다 — 사건의 순서는 서버의 사실이다.
  _runPaintTimeline(root, d) {
    const el = root.querySelector('.run-timeline');
    const items = d.timeline || [];
    reconcileList(el, items, {
      key: it => (it.at || 0) + ':' + (it.kind || '') + ':' + (it.memberId || ''),
      sig: it => (it.kind || '') + ':' + (it.text || ''),
      build: it => {
        const row = runDiv('run-tl-row');
        row.appendChild(runDiv('run-tl-at', this._runClock(it.at)));
        row.appendChild(runDiv('run-tl-kind k-' + (it.kind || ''), it.kind || ''));
        row.appendChild(runDiv('run-tl-text', it.text || ''));
        return row;
      },
    });
  },

  // ── 표기 ──

  // 토큰 수를 사람이 읽을 크기로. 1000 단위이며 소수 한 자리다 — 컨텍스트는
  // 자릿수가 읽히면 되고, 정확한 값은 툴팁이 아니라 기록의 것이다.
  _runTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'k';
    return String(Math.round(v));
  },


  // 서버 시각은 Unix **초**다 (run/store.go 의 now()).
  _runAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return tn('core.dur_sec', s);
    if (s < 3600) return tn('core.dur_min', Math.floor(s / 60));
    if (s < 86400) return tn('core.dur_hour', Math.floor(s / 3600));
    return tn('core.dur_day', Math.floor(s / 86400));
  },

  _runClock(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  },
});
