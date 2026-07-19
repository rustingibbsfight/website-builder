import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Use the container's preinstalled Chromium regardless of playwright version.
const chromiumPath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find((p) => existsSync(p));

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  webServer: [
    {
      command: 'node setup-and-serve.mjs',
      url: 'http://127.0.0.1:5173/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node editor-server.mjs',
      url: 'http://127.0.0.1:4600/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
