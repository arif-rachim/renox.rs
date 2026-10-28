// Drives the four shop interactions in Chromium (#45) against a running
// `renox dev`, under the strict CSP (#47): list, live search, detail, add to
// cart. Prints a JSON report (problems lists console errors, CSP violations
// included); screenshots go to argv[2]. Run through browser-check.ts.
// Playwright is not a dependency of the repo: PLAYWRIGHT_PATH points at
// an installed copy (its index.js), else the global `playwright` package.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const [, , shots, base] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const problems = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
const report = {};
await page.goto(`${base}/products`);
report.cards = await page.locator("article.card").count();
report.cssLoaded = await page.evaluate(() => getComputedStyle(document.querySelector(".site-header")).display === "flex");
report.htmxLoaded = await page.evaluate(() => typeof window.htmx === "object");
await page.screenshot({ path: `${shots}/1-list.png` });
await page.fill("input[name=q]", "saffron");
await page.waitForFunction(() => document.querySelectorAll("article.card").length === 8, null, { timeout: 5000 });
report.searchCards = await page.locator("article.card").count();
report.url = page.url();
await page.screenshot({ path: `${shots}/2-search.png` });
await page.click("article.card h3 a");
await page.waitForSelector("#product h1");
report.detail = await page.locator("#product h1").innerText();
await page.screenshot({ path: `${shots}/3-detail.png` });
await page.fill("input[name=quantity]", "2");
await page.click("#product button[type=submit]");
await page.waitForSelector("#product .notice", { timeout: 5000 });
report.notice = await page.locator("#product .notice").innerText();
report.badge = await page.locator("#cart-badge").innerText();
await page.screenshot({ path: `${shots}/4-add-to-cart.png` });
report.problems = problems;
console.log(JSON.stringify(report, null, 2));
await browser.close();
const ok = report.cards === 100 && report.cssLoaded && report.htmxLoaded && report.searchCards === 8 && report.badge === "2" && problems.length === 0;
process.exit(ok ? 0 : 1);
