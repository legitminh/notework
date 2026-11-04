import { defineConfig } from '@playwright/test';

const production = process.env.PLAYWRIGHT_PRODUCTION === '1';
const baseURL = production ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL,
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: 'retain-on-failure'
  },
  webServer: {
    command: production ? 'pnpm preview --host 127.0.0.1 --port 4173' : 'pnpm dev --host 127.0.0.1',
    url: baseURL,
    reuseExistingServer: !process.env.CI
  }
});
