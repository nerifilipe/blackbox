import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(process.env.BLACKBOX_TEST_DATA_ROOT || tmpdir(), 'blackbox-e2e-'));
const binary = process.platform === 'win32' ? '..\\dist\\blackbox.exe' : '../dist/blackbox';

export default defineConfig({
 testDir: './tests',
 fullyParallel: false,
 workers: 1,
 timeout: 30000,
 expect: { timeout: 7000 },
 reporter: [['list'], ['html', { open: 'never' }]],
 use: { baseURL: 'http://127.0.0.1:19090', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
 projects: [
  { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 }, ...(process.env.BLACKBOX_BROWSER_CHANNEL ? { channel: process.env.BLACKBOX_BROWSER_CHANNEL } : {}) } },
  { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(process.env.BLACKBOX_BROWSER_CHANNEL ? { channel: process.env.BLACKBOX_BROWSER_CHANNEL } : {}) } },
 ],
 webServer: {
  command: `"${binary}" serve -ui 127.0.0.1:19090 -proxy 127.0.0.1:19091 -demo 127.0.0.1:19092 -db "${join(dataDir, 'history.db')}"`,
  url: 'http://127.0.0.1:19090/api/state', reuseExistingServer: false, timeout: 15000,
 },
});
