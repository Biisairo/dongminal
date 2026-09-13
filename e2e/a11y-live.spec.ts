import { test, expect, waitForInit, liveRegionOf } from './fixtures';

// ACCESSIBILITY_BASELINE_SRS §5.1 TC-A11Y-10 (FR-A11Y-19 / M7 `UX-8`).
//
// 착수 실측: 이 앱의 `aria-live` 리전은 **0개**다(벤더 제외). 알림은 넷으로
// 흩어져 있었다 — `Toast`·`.git-undo-toast`·`.sbx-progress`·`.tp-overlay`.
//
// **재는 것은 "리전이 있다" 가 아니다** (D-A11Y-4). `aria-live` 를 어딘가에 붙이는
// 것은 한 줄이고, 문구가 그 리전의 **자손**이 아니면 아무것도 읽히지 않는다.
// 그래서 문구를 찾고 그 요소에서 위로 올라가 리전을 찾는다 (`liveRegionOf`).
//
// **여기 있는 것은 구조 하나뿐이다.** 문구가 실제로 들어오는지는 그 알림을 띄우는
// 설정이 이미 있는 자리에서 잰다 — 업로드 실패는 `file-transfer.spec.ts` FT12,
// Undo 는 `git-commit.spec.ts` E6, 재연결·종료는 `reconnect-storm.spec.ts`
// V-RCS-6 이다. 하네스를 복사하면 그 복사본이 따로 낡는다.

test.describe('접근성 — 알림이 읽힌다 (FR-A11Y-19 / UX-8)', () => {
  test('TC-A11Y-10a: 알림 호스트가 **비어 있을 때부터** 리전이다', async ({ page }) => {
    await waitForInit(page);

    /**
     * 리전은 **내용이 바뀌기 전에 DOM 에 있어야** 읽힌다. 알림이 뜰 때 리전째로
     * 새로 붙이면 보조기술이 그 변화를 놓치는 구현이 있다 — 착수 시 `Toast` 가
     * 정확히 그랬다(첫 `show()` 에서 호스트를 만든다). 그래서 **비어 있는 동안**을
     * 따로 본다: 여기가 초록이면 "알림이 뜨면 리전이 생긴다" 가 아니라 "리전이
     * 먼저 있고 그 안에 알림이 들어온다" 다.
     */
    const host = page.locator('#toast-host');
    await expect(host, '알림 호스트가 부팅 뒤에 서 있지 않다').toHaveCount(1);
    await expect(host.locator('.toast'), '전제: 아직 알림이 없다').toHaveCount(0);

    const r = await liveRegionOf(host);
    expect(r, '알림 호스트가 라이브 리전이 아니다').not.toBeNull();
    expect(r!.role === 'status' || r!.live === 'polite' || r!.live === 'assertive',
      '리전의 정체가 status/polite/assertive 중 하나여야 한다: ' + JSON.stringify(r)).toBe(true);
  });
});
