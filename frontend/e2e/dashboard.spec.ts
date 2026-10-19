import { expect, test } from "@playwright/test";

test("core workflow: subtype, grouping, genotype, filters, views, export", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("frequency-chart").locator(".main-svg").first()).toBeVisible();
  await expect(page.getByText("Relative frequencies only.")).toBeVisible();

  // subtype switch updates segments and builds
  await page.selectOption("#subtype", "h3n2");
  await expect(page.locator(".buildcard.global")).toContainText("h3n2");
  await page.getByRole("radio", { name: "NA", exact: true }).click();
  await expect(page.locator(".buildcard.local")).toContainText("_na");
  await page.getByRole("radio", { name: "HA", exact: true }).click();

  // global build selector offers only compatible builds
  const globals = await page.locator("#global option").allTextContents();
  expect(globals.every((t) => /h3n2/i.test(t))).toBeTruthy();

  // clade grouping
  await page.selectOption("#grouping", "clade");
  await expect(page.locator("h1")).toContainText("Clade");

  // genotype with submenu
  await page.selectOption("#grouping", "genotype");
  await page.locator(".chips.suggest .chip").first().click();
  await expect(page.locator("h1")).toContainText("Genotype");
  await expect(page.locator("table.snap tbody tr").first()).toBeVisible();

  // filters: one section, three scopes
  await page.selectOption("#grouping", "subclade");
  const incLocal = page.locator(".inc-row.local .inc-num");
  const incGlobal = page.locator(".inc-row.global .inc-num");
  await expect(incLocal).toContainText("420 / 420");
  // global-only filter
  await page.getByRole("tab", { name: /Nextstrain global/ }).click();
  await page.locator(".field-btn", { hasText: "Region" }).click();
  await page.locator(".vrow").first().click();
  await expect(page.locator(".filterbar .fchip.global")).toHaveCount(1);
  await expect(incGlobal).not.toContainText("900 / 900");
  await expect(incLocal).toContainText("420 / 420");
  await page.locator(".filterbar .fchip.global .fchip-x").click();
  await expect(page.locator(".filterbar .fchip")).toHaveCount(0);
  // filter applied to both datasets
  await page.getByRole("tab", { name: /Both datasets/ }).click();
  await page.locator(".field-btn", { hasText: "Subclade" }).click();
  await page.locator(".vrow").first().click();
  await expect(page.locator(".filterbar .fchip.both")).toHaveCount(1);
  await expect(incLocal).not.toContainText("420 / 420");
  await expect(incGlobal).not.toContainText("900 / 900");
  await expect(page.locator(".tab.both .badge-n")).toHaveText("1");
  await expect(page.locator(".prov.comparison")).toContainText("Filters on both datasets");
  await page.locator(".filters-section").getByRole("button", { name: "Clear all" }).click();
  await expect(page.locator(".filterbar .fchip")).toHaveCount(0);

  // local (top) and global (bottom) panels use identical timepoints and x range
  const axes = await page.evaluate(() => {
    const gd: any = document.querySelector("[data-testid=frequency-chart]");
    const xs = (ax: string) => gd.data.filter((t: any) => t.xaxis === ax).map((t: any) => JSON.stringify(t.x));
    return { top: xs("x2"), bottom: xs("x"), r1: gd._fullLayout.xaxis.range, r2: gd._fullLayout.xaxis2.range };
  });
  const top: string[] = JSON.parse(axes.top[0]);
  const bottom: string[] = JSON.parse(axes.bottom[0]);
  const overlap = bottom.filter((d) => d >= top[0] && d <= top[top.length - 1]);
  expect(overlap.length).toBeGreaterThan(3);
  expect(overlap.every((d) => top.includes(d))).toBeTruthy(); // same timepoints where both have data
  expect(axes.r1).toEqual(axes.r2);
  await expect(page.getByTestId("alignment-note")).toContainText("same timepoints");
  await page.getByRole("radio", { name: "Native pivots" }).click();
  await expect(page.getByText(/Native pivots: each panel/)).toBeVisible();
  await page.getByRole("radio", { name: "Shared timepoints" }).click();

  // views and presets
  for (const v of ["Overlay", "Difference", "Side by side"]) await page.getByRole("tab", { name: v }).click();
  await page.getByRole("button", { name: "12 mo" }).click();
  await expect(page.locator(".dates input[aria-label='Start date']")).not.toHaveValue("");

  // snapshot single month + sort
  await page.getByRole("button", { name: "Single timepoint" }).click();
  await expect(page.locator(".card .sub", { hasText: "Timepoint:" })).toBeVisible();

  // provenance panel shows the not-available marker
  await expect(page.locator(".prov.local")).toContainText("Not supplied in manifest");

  // export
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.getByRole("button", { name: /Download figure/ }).click();
      await page.getByRole("menuitem", { name: "SVG" }).click();
    })(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.svg$/);
  expect(errors).toEqual([]);
});
