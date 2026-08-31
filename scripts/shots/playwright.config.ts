import { defineConfig } from '@playwright/test';

// 그림 전용 설정. e2e 와 갈라 두는 이유는 **서버를 띄우지 않기** 때문이다 —
// 격리 인스턴스는 shoot.sh 가 띄우고, 여기서는 찍기만 한다.
export default defineConfig({
  testDir: '.',
  workers: 1,
  use: { viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 },
});
