/**
 * Run 복구 버튼 (RUN_RECOVERY_SRS 묶음 W). 데몬이 죽은 뒤 빈 셸이 된 에이전트를 세션 id 로 재개한다.
 * `run-dashboard.js` 의 증강 분할이다 — 그 파일이 500줄 경계를 넘지 않게 갈랐다(FR-STR-40).
 * 판정과 재개는 서버가 한다. 화면은 요청을 보내고 결과를 알린다.
 */

/** FR-RRC-20: 요청 본문. target 이 없으면 Run 단위다. 강제는 대상 하나일 때만 싣는다. */
function runRecoverBody(runId, target, force) {
  const b = { runId };
  if (target && target.coord) b.coordinator = true;
  else if (target) b.memberId = target.id;
  if (target && force) b.force = true;
  return b;
}

/** FR-RRC-30: Run 단위 버튼은 조정자나 멤버 하나라도 복구할 수 있을 때만 선다. */
function runRecoverAny(d) {
  return !!(d && (d.coordinatorRecoverable || (d.members || []).some(m => m.recoverable)));
}

/** FR-RRC-33: 결과 요약 — 재개·건너뜀·실패 수, 확인이 필요한가, 사유들. 실패는 사유 `failed` 하나로 묶는다. */
function runRecoverSummary(results) {
  const list = results || [];
  const count = o => list.filter(r => r.outcome === o).length;
  const reasons = list.filter(r => r.outcome === 'skipped' && r.reason).map(r => r.reason);
  if (count('failed')) reasons.push('failed');
  return {
    resumed: count('resumed'), skipped: count('skipped'), failed: count('failed'),
    needsForce: list.some(r => r.needsForce), reasons: [...new Set(reasons)],
  };
}

/** FR-RRC-33: 건너뛴 사유의 문구. 키는 조립하지 않는다. */
const RUN_RECOVER_REASONS = {
  'ended': 'runs.recover_r_ended',
  'no-tool': 'runs.recover_r_no_tool',
  'no-agent': 'runs.recover_r_no_agent',
  'no-resume': 'runs.recover_r_no_resume',
  'no-session': 'runs.recover_r_no_session',
  'bad-session': 'runs.recover_r_bad_session',
  'unknown': 'runs.recover_r_unknown',
  'running-here': 'runs.recover_r_running_here',
  'running-elsewhere': 'runs.recover_r_running_elsewhere',
  'busy': 'runs.recover_r_busy',
  'recovering': 'runs.recover_r_recovering',
  'failed': 'runs.recover_r_failed',
};

Object.assign(RunsPanel.prototype, {
  /** FR-RRC-31: 대상 하나의 복구 버튼. 카드 클릭(그 도구로 가기)으로 번지지 않는다. */
  _runRecoverBtn(runId, target) {
    const btn = UIKit.button({ label: t('runs.recover'), title: TIP_RUNS_RECOVER_ONE, size: 'sm', cls: 'run-recover',
      dataset: { member: target.id }, onClick: e => { e.stopPropagation(); this._runRecover(runId, target, false, btn) } });
    return btn;
  },

  /** FR-RRC-30: 요약 줄 아래의 Run 단위 버튼. 복구할 것이 없으면 비운다. */
  _runPaintRecover(root, d) {
    const sum = root.querySelector('.run-summary');
    if (!sum) return;
    let bar = root.querySelector('.run-recover-bar');
    if (!bar) { bar = domEl('div', 'run-recover-bar'); sum.after(bar) }
    const show = d.state === 'open' && runRecoverAny(d);
    paintIfChanged(bar, show ? d.runId : '', () => {
      bar.textContent = '';
      if (!show) return;
      const btn = UIKit.button({ label: t('runs.recover_all'), title: TIP_RUNS_RECOVER_ALL, size: 'sm', cls: 'run-recover-all',
        onClick: () => this._runRecover(d.runId, null, false, btn) });
      bar.appendChild(btn);
    });
  },

  /**
   * FR-RRC-30~34: 복구 한 번. 누른 동안 버튼을 막는다. 대상 하나가 판정 불가면 토스트의
   * "계속" 으로 확인을 받고 강제로 다시 부른다 — 사람이 화면을 보고 빈 셸임을 확인한 것이다.
   */
  async _runRecover(runId, target, force, btn) {
    // FR-RRC-34: 같은 대상은 응답이 오기 전까지 한 번만 — SVG 단추와 「계속」 에는 막을 disabled 가 없다.
    const key = runId + '/' + (target ? target.id : '');
    if (!this._runRecovering) this._runRecovering = new Set();
    if (this._runRecovering.has(key)) return;
    this._runRecovering.add(key);
    if (btn) btn.disabled = true;
    const r = await apiPost(RUNS_RECOVER_API, runRecoverBody(runId, target, force));
    if (btn) btn.disabled = false;
    this._runRecovering.delete(key);
    if (!r.ok || !r.data) { Toast.show(apiErrText(r, t('runs.recover_fail')), 'err', TOAST_ERR_MS); return }
    const s = runRecoverSummary(r.data.results);
    if (target && s.needsForce) {
      // 출구는 시한이다 — 버튼이 달린 토스트는 눌러도 닫히지 않으므로 「계속」 도 직접 닫는다.
      const q = Toast.show(t('runs.recover_q_force'), '', TOAST_ERR_MS, { actions: [{ label: t('runs.recover_force'),
        title: TIP_RUNS_RECOVER_FORCE, onClick: () => { q.close(); return this._runRecover(runId, target, true) } }] });
      return;
    }
    const why = s.reasons.map(k => t(RUN_RECOVER_REASONS[k] || 'runs.recover_r_other')).join(' · ');
    Toast.show(t('runs.recover_done', { ok: s.resumed, skip: s.skipped, fail: s.failed }) + (why ? ' — ' + why : ''),
      s.resumed ? 'ok' : 'err', TOAST_MS);
    this._runRefreshViewsOf(runId);
  },
});

// FR-RRC-31: 트리 노드 오른쪽 위의 복구 단추(SVG). 노드 클릭(그 도구로 가기)으로 번지지 않는다.
const RUN_TREE_RECOVER_W = 40;
const RUN_TREE_RECOVER_H = 16;
const RUN_TREE_RECOVER_PAD = 6;
// 단추와 그 여백이 차지하는 제목 칸(반각). 상자 184px 에 26칸이 들므로 한 칸은 약 7px 이다.
const RUN_TREE_RECOVER_UNITS = 7;

Object.assign(RunsPanel.prototype, {
  _runTreeRecoverEl(n, p) {
    const x = p.x + p.w / 2 - RUN_TREE_RECOVER_W - RUN_TREE_RECOVER_PAD;
    const y = p.y + RUN_TREE_RECOVER_PAD;
    const g = svgEl('g', { class: 'run-tree-recover', role: 'button', tabindex: '0' });
    const tip = svgEl('title');
    tip.textContent = TIP_RUNS_RECOVER_ONE;
    g.appendChild(tip);
    g.appendChild(svgEl('rect', { x, y, width: RUN_TREE_RECOVER_W, height: RUN_TREE_RECOVER_H, rx: 3 }));
    const label = svgEl('text', { x: x + RUN_TREE_RECOVER_W / 2, y: y + 12, 'text-anchor': 'middle' });
    label.textContent = t('runs.recover');
    g.appendChild(label);
    const go = e => { e.stopPropagation(); this._runRecover(n.runId, n, false) };
    g.addEventListener('click', go);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e) } });
    return g;
  },
});
