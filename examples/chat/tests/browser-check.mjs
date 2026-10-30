// Drives examples/chat in Chromium (#282) against a running `renox dev`:
// two users sign up and sign in, join #general, and each sees the other's
// message as the fragment the server rendered; #team (private) is 403.
// Prints a JSON report; screenshots go to argv[2]. Run through browser-check.ts.
// Playwright is not a dependency of the repo: PLAYWRIGHT_PATH points at an
// installed copy (its index.js), else the global `playwright` package.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const [, , shots, base] = process.argv;
const browser = await chromium.launch();
const problems = [];
async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${name} ${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${name} pageerror: ${e.message}`));
  const email = `${name.toLowerCase()}@example.com`;
  await page.goto(`${base}/auth/register`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", "correct horse battery");
  const display = page.locator("input[name=display_name]");
  if (await display.count()) await display.fill(name);
  await page.click("button[type=submit]");
  await page.goto(`${base}/auth/login`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", "correct horse battery");
  await page.click("form button[type=submit]");
  await page.waitForURL(`${base}/`);
  return page;
}
const report = {};
const lina = await user("Lina");
const omar = await user("Omar");
await lina.goto(`${base}/`);
report.rooms = await lina.locator("#rooms li").count();
await lina.screenshot({ path: `${shots}/1-rooms.png` });
await lina.goto(`${base}/rooms/general`);
await omar.goto(`${base}/rooms/general`);
await lina.waitForTimeout(500);
await lina.fill("input[name=text]", "Salam! Is the order ready?");
await lina.press("input[name=text]", "Enter");
await omar.waitForSelector("#messages p.message", { timeout: 5000 });
await omar.fill("input[name=text]", "Yes, it ships today.");
await omar.press("input[name=text]", "Enter");
await lina.waitForFunction(() => document.querySelectorAll("#messages p.message").length === 2, null, { timeout: 5000 });
report.linaSees = await lina.locator("#messages p.message").allInnerTexts();
report.omarSees = await omar.locator("#messages p.message").allInnerTexts();
await omar.screenshot({ path: `${shots}/2-room.png` });
const team = await lina.goto(`${base}/rooms/team`);
report.privateStatus = team?.status();
await lina.screenshot({ path: `${shots}/3-private-room.png` });
report.problems = problems.filter((p) => !p.includes("403"));
console.log(JSON.stringify(report, null, 2));
await browser.close();
const ok = report.rooms === 1 && report.linaSees.length === 2 && report.omarSees.length === 2 && report.privateStatus === 403 && report.problems.length === 0;
process.exit(ok ? 0 : 1);
