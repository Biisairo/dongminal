/**
 * ISSUE_TREE_OPS_SRS FR-ITC-12~16: 트리 보기의 계산. DOM 을 만지지 않는다.
 *
 * 보기는 {s, x, y} 다 — s 는 화면 px / viewBox 단위, (x, y) 는 보는 범위의 왼쪽 위(viewBox 좌표).
 * 트리 크기 `{w, h}` 는 viewBox 단위, 영역 크기 `{w, h}` 는 화면 px 다.
 */

// FR-ITC-12: 맞춤의 상한 — 작은 트리가 표지처럼 커지지 않게 (FR-FIT-3 과 같은 값).
const RUN_CAM_FIT_MAX = 1.5;
// FR-ITC-13: 배율 범위.
const RUN_CAM_MIN = 0.2;
const RUN_CAM_MAX = 3;

/** 트리 전체가 영역에 들어오는 배율로 가운데에 놓는다. 잴 수 없으면 null. */
function runCamFit(tree, area) {
  if (!tree.w || !tree.h || !area.w || !area.h) return null;
  const s = Math.min(RUN_CAM_FIT_MAX, area.w / tree.w, area.h / tree.h);
  return runCamCenterOn({ s, x: 0, y: 0 }, tree.w / 2, tree.h / 2, area);
}

/** 맞춤 배율이 하한보다 작으면 하한은 맞춤 배율이다 — 맞춤으로 돌아갈 수 없는 범위는 없다. */
function runCamRange(fitS) {
  return { min: Math.min(RUN_CAM_MIN, fitS), max: RUN_CAM_MAX };
}

/** 영역 안 화면 점 (px, py) 아래의 트리 점을 그 자리에 두고 배율을 factor 배 한다. */
function runCamZoomAt(cam, factor, px, py, range) {
  const s = Math.min(range.max, Math.max(range.min, cam.s * factor));
  return { s, x: cam.x + px / cam.s - px / s, y: cam.y + py / cam.s - py / s };
}

/** 화면에서 (dx, dy) 만큼 끌었다 — 보는 범위는 반대로 움직인다. */
function runCamPan(cam, dx, dy) {
  return { s: cam.s, x: cam.x - dx / cam.s, y: cam.y - dy / cam.s };
}

/** (tx, ty) 를 보는 범위의 가운데로 놓는다. */
function runCamCenterOn(cam, tx, ty, area) {
  return { s: cam.s, x: tx - area.w / cam.s / 2, y: ty - area.h / cam.s / 2 };
}

/** FR-ITC-14: 보는 범위의 가운데가 트리 경계 안에 남게 한다. */
function runCamClamp(cam, tree, area) {
  const hw = area.w / cam.s / 2, hh = area.h / cam.s / 2;
  const cx = Math.min(tree.w, Math.max(0, cam.x + hw));
  const cy = Math.min(tree.h, Math.max(0, cam.y + hh));
  return { s: cam.s, x: cx - hw, y: cy - hh };
}

/**
 * UX_BATCH12_SRS FR-RMM-3: 미니맵을 누른 트리 점 p. 보기 상자 안이면 보기를 그대로 두고, 밖이면
 * 그 점을 가운데로 옮긴다. 돌려주는 `off` 는 잡은 점과 보기 왼쪽 위의 거리다 — 끄는 동안 지킨다.
 */
function runCamGrab(cam, area, p) {
  const w = area.w / cam.s, h = area.h / cam.s;
  const inside = p.x >= cam.x && p.x <= cam.x + w && p.y >= cam.y && p.y <= cam.y + h;
  const c = inside ? cam : runCamCenterOn(cam, p.x, p.y, area);
  return { cam: c, off: { x: p.x - c.x, y: p.y - c.y } };
}

/** FR-RMM-3: 잡은 거리 `off` 를 지키며 트리 점 q 로 끈 보기. */
function runCamDragTo(cam, off, q) {
  return { s: cam.s, x: q.x - off.x, y: q.y - off.y };
}
