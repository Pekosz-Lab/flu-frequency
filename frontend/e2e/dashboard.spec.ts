import { expect, test, type Page } from "@playwright/test";

/** x values of the local (top, x2) and global (bottom, x) panels in the side-by-side view */
async function panelDates(page: Page) {
  return page.evaluate(() => {
    const gd: any = document.querySelector("[data-testid=frequency-chart]");
    const xs = (ax: string) => gd.data.filter((t: any) => t.xaxis === ax).map((t: any) => t.x as string[]);
    return { top: xs("x2")[0] as string[], bottom: xs("x")[0] as string[], r1: gd._fullLayout.xaxis.range, r2: gd._fullLayout.xaxis2.range };
  });
}

test("core workflow: subtype, grouping, genotype, filters, dates, views, export", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("frequency-chart").locator(".main-svg").first()).toBeVisible();
  await expect(page.getByText("Relative frequencies only.")).toBeVisible();

  // default view: only the dates where both datasets have data, and both panels line up exactly
  await expect(page.getByRole("button", { name: "Overlap" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dates input[aria-label='Start date']")).not.toHaveValue("");
  const def = await panelDates(page);
  expect(def.top.length).toBeGreaterThan(3);
  expect(def.top).toEqual(def.bottom);
  expect(def.r1).toEqual(def.r2);
  await expect(page.getByTestId("alignment-note")).toContainText("same timepoints");

  // subtype switch updates segments and builds
  await page.getByRole("radiogroup", { name: "Subtype" }).getByRole("radio", { name: /H3N2/ }).click();
  await expect(page.locator(".buildcard.global")).toContainText("h3n2");
  await page.getByRole("radio", { name: "NA", exact: true }).click();
  await expect(page.locator(".buildcard.local")).toContainText("_na");
  await page.getByRole("radio", { name: "HA", exact: true }).click();

  // global build selector offers only compatible builds
  const globals = await page.locator("#global [role=radio]").evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
  expect(globals.length).toBeGreaterThan(0);
  expect(globals.every((t) => /h3n2/i.test(t))).toBeTruthy();

  // clade grouping
  await page.getByRole("radio", { name: "Clade", exact: true }).click();
  await expect(page.locator("h1")).toContainText("Clade");

  // genotype with submenu
  await page.getByRole("radio", { name: "Genotype", exact: true }).click();
  await page.locator(".chips.suggest .chip").first().click();
  await expect(page.locator("h1")).toContainText("Genotype");
  await expect(page.locator("table.snap tbody tr").first()).toBeVisible();

  // filters: one search box, three scopes
  await page.getByRole("radio", { name: "Subclade", exact: true }).click();
  const incLocal = page.locator(".inc-row.local .inc-num");
  const incGlobal = page.locator(".inc-row.global .inc-num");
  await expect(incLocal).toContainText("420 / 420");
  const search = page.getByRole("combobox", { name: "Filter data" });
  // global-only filter, found by typing the attribute name
  await search.fill("region");
  await page.locator(".field-opt", { hasText: "Region" }).first().click();
  await page.locator(".value-opt").first().click();
  await expect(page.locator(".fchip.global")).toHaveCount(1);
  await expect(incGlobal).not.toContainText("900 / 900");
  await expect(incLocal).toContainText("420 / 420");
  await page.locator(".fchip.global .fchip-x").click();
  await expect(page.locator(".fchip")).toHaveCount(0);
  // filter applied to both datasets, found by browsing
  await page.keyboard.press("Escape"); // back to all attributes
  await page.keyboard.press("Escape"); // close
  await search.click();
  await page.locator(".field-opt", { hasText: "Subclade" }).first().click();
  await page.locator(".value-opt").first().click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".fchip.both")).toHaveCount(1);
  await expect(incLocal).not.toContainText("420 / 420");
  await expect(incGlobal).not.toContainText("900 / 900");
  await expect(page.locator(".prov.comparison")).toContainText("Filters on both datasets");
  // the same filter moved to the global build only, and back
  await page.locator(".fchip.both select.fchip-scope").selectOption("global");
  await expect(page.locator(".fchip.global")).toHaveCount(1);
  await expect(page.locator(".fchip.both")).toHaveCount(0);
  await expect(incLocal).toContainText("420 / 420");
  await page.locator(".fchip.global select.fchip-scope").selectOption("both");
  await expect(page.locator(".fchip.both")).toHaveCount(1);
  // the range follows the overlap of the filtered data: panels still line up
  const filtered = await panelDates(page);
  expect(filtered.top).toEqual(filtered.bottom);
  await page.locator(".fbox-clear").click();
  await expect(page.locator(".fchip")).toHaveCount(0);

  // time axis lives under Display options
  await page.getByText("Display options").click();
  await page.getByRole("radio", { name: "Native" }).click();
  await expect(page.getByText(/Native pivots: each panel/)).toBeVisible();
  await page.getByRole("radio", { name: "Shared", exact: true }).click();

  // views and date presets
  for (const v of ["Overlay", "Difference", "Side by side"]) await page.getByRole("tab", { name: v }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".dates input[aria-label='Start date']")).toHaveValue("");
  await page.getByRole("button", { name: "12 mo" }).click();
  await expect(page.locator(".dates input[aria-label='Start date']")).not.toHaveValue("");
  await page.getByRole("button", { name: "Overlap" }).click();

  // snapshot at a single timepoint, sortable columns
  await page.getByRole("button", { name: "single timepoint" }).click();
  await expect(page.locator(".card .sub", { hasText: /^at / })).toBeVisible();
  await page.getByRole("button", { name: /^Taxon/ }).click();
  await expect(page.locator("th[aria-sort=ascending]")).toContainText("Taxon");

  // provenance panel shows the not-available marker
  await expect(page.locator(".prov.local")).toContainText("Not supplied in manifest");

  // export
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.getByRole("button", { name: /Download/ }).click();
      await page.getByRole("menuitem", { name: "SVG" }).click();
    })(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.svg$/);
  expect(errors).toEqual([]);
});
