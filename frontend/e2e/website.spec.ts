import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Website build (`npm run build:web`) served at a GitHub Pages-like sub-path:
//   SITE_URL=http://127.0.0.1:8090/flu-freq-compare/  (see README "Testing the website")
// nextstrain.org is intercepted and answered with the SYNTHETIC demo builds (`ffc demo`).
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:8090/flu-freq-compare/";
const DEMO = resolve(new URL(".", import.meta.url).pathname, "../../data/demo");
const LOCAL_DIR: Record<string, string> = { h1n1: "h1n1pdm", h3n2: "h3n2", vic: "vic" };

test.skip(!existsSync(DEMO), "run `ffc demo` first");

test("public website: homepage, analysis from public builds only, run-locally page", async ({ page }) => {
  const requested: { url: string; accept: string; cookie: boolean }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.route("https://nextstrain.org/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\//, "");
    const accept = req.headers()["accept"] ?? "";
    requested.push({ url: path, accept, cookie: "cookie" in req.headers() });
    let file: string | null = null;
    const kind = accept.includes("tip-frequencies") ? "_tip-frequencies" : accept.includes("root-sequence") ? "_root-sequence" : "";
    let m = /^flu\/seasonal\/(\w+)\/(ha|na)\/(\w+)$/.exec(path);
    if (m) file = `${DEMO}/global/${m[1]}/${m[2]}/${m[3]}/dataset${kind}.json`;
    m = /^groups\/PekoszLab-Public\/seasonal-flu\/(\w+)\/(ha|na)$/.exec(path);
    if (m) file = `${DEMO}/local/${LOCAL_DIR[m[1]]}/${m[2]}/auspice${kind}.json`;
    if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: "Not Found", headers: { "access-control-allow-origin": "*" } });
    return route.fulfill({ status: 200, body: readFileSync(file), headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  });

  // homepage -> analysis
  await page.goto(SITE);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("side by side");
  await expect(page.locator("#caveat")).toContainText("Relative frequencies only");
  await page.getByRole("link", { name: /Open the analysis/ }).click();
  await expect(page).toHaveURL(/\/analysis\/$/);
  await expect(page.locator(".banner.public")).toContainText("never accesses private builds");
  await expect(page.getByTestId("frequency-chart").locator(".main-svg").first()).toBeVisible({ timeout: 30_000 });

  // a full workflow in the browser engine
  await expect(page.getByRole("button", { name: "Overlap" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radiogroup", { name: "Subtype" }).getByRole("radio", { name: /H3N2/ }).click();
  await expect(page.locator(".buildcard.global")).toContainText("tips");
  await page.getByRole("combobox", { name: "Filter data" }).click();
  await page.locator(".field-opt", { hasText: "Subclade" }).first().click();
  await page.locator(".value-opt").first().click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".fchip.both")).toHaveCount(1);
  await page.getByRole("radio", { name: "Genotype", exact: true }).click();
  await page.locator(".chips.suggest .chip").first().click();
  await expect(page.locator("table.snap tbody tr").first()).toBeVisible();
  await page.getByRole("tab", { name: "Difference" }).click();
  await expect(page.getByTestId("alignment-note")).toContainText("same timepoints");

  // exports work in the browser; no PDF on the website
  await page.getByRole("button", { name: /Download/ }).click();
  await expect(page.getByRole("menuitem", { name: "PDF" })).toHaveCount(0);
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /PNG/ }).click()]);
  expect(png.suggestedFilename()).toMatch(/\.png$/);
  await page.getByRole("button", { name: /Download/ }).click();
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Trajectories CSV", exact: true }).click()]);
  const text = readFileSync(await csv.path(), "utf8");
  expect(text).toContain("# Caveat:");
  expect(text).not.toMatch(/Synthetic-local\/\d/); // no strain names in exports

  // run-locally page
  await page.getByRole("link", { name: /run the app on your own computer/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Private builds");
  await expect(page.getByText("ffc start").first()).toBeVisible();

  // PRIVACY: every request went to public nextstrain.org datasets, with the right media type, no cookies
  expect(requested.length).toBeGreaterThan(0);
  for (const r of requested) {
    expect(r.url).toMatch(/^(flu\/seasonal\/|groups\/PekoszLab-Public\/)/);
    expect(r.url).not.toMatch(/groups\/PekoszLab\//);
    expect(r.accept).toMatch(/^application\/vnd\.nextstrain\.dataset\.(main|tip-frequencies|root-sequence)\+json$/);
    expect(r.cookie).toBeFalsy();
  }
  expect(errors).toEqual([]);
});
