import { defineConfig } from '@playwright/test';
const live = !!process.env.BASE_URL;
const channel = process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {};
export default defineConfig({ testDir: './tests/e2e', timeout: 60_000, expect: { timeout: 15_000 }, fullyParallel: false, workers: 2, retries: 0, reporter: [['list'], ['json', { outputFile: 'qa-local/e2e-results.json' }]], use: { baseURL: process.env.BASE_URL || 'http://127.0.0.1:4178', trace: 'retain-on-failure', screenshot: 'only-on-failure' }, projects: [
  { name: 'chromium-desktop', use: { browserName: 'chromium', ...channel, viewport: { width: 1440, height: 1000 } } },
  { name: 'firefox-desktop', use: { browserName: 'firefox', viewport: { width: 1440, height: 1000 } } },
  { name: 'webkit-desktop', use: { browserName: 'webkit', viewport: { width: 1440, height: 1000 } } },
  { name: 'chromium-mobile', use: { browserName: 'chromium', ...channel, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  { name: 'firefox-mobile', use: { browserName: 'firefox', viewport: { width: 390, height: 844 }, hasTouch: true } },
  { name: 'webkit-mobile', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
], ...(!live ? { webServer: { command: 'npm run preview -- --port 4178', url: 'http://127.0.0.1:4178', reuseExistingServer: true } } : {}) });
