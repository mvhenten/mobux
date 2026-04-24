const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.cjs',
  timeout: 30000,
  retries: 0,
  use: {
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        ...devices['Pixel 7'],
      },
    },
  ],
});
