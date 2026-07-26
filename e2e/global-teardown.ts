import { readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

async function globalTeardown() {
  // Clean up /tmp/dongminal-e2e-* directories left by this test run
  const tmpDir = '/tmp';
  try {
    const entries = readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith('dongminal-e2e-')) {
        const fullPath = join(tmpDir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            rmSync(fullPath, { recursive: true, force: true });
          }
        } catch {
          // skip entries we can't remove
        }
      }
    }
  } catch {
    // /tmp may not be readable — skip cleanup
  }
}

export default globalTeardown;
