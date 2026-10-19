import { defineConfig } from "@playwright/test";

// Run against a demo store:  ffc demo && ffc serve --store store-demo   (then)  npm run test:e2e
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: {
    baseURL: process.env.FFC_URL ?? "http://127.0.0.1:8050",
    viewport: { width: 1440, height: 950 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
});
