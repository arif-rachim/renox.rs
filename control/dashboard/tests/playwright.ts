// Playwright for the browser tests (#445, #446), without a dependency: the
// package the machine has (PLAYWRIGHT_PATH, else wherever Node resolves it;
// bun test does not read NODE_PATH), typed by the few calls the tests make.

export interface PwRoute {
  request(): { method(): string; postData(): string | null };
  continue(): Promise<void>;
  fulfill(r: { status: number; contentType: string; body: string }): Promise<void>;
}
export interface PwPage {
  goto(url: string, opts?: { waitUntil?: "load" | "networkidle" }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  check(selector: string): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  inputValue(selector: string): Promise<string>;
  isChecked(selector: string): Promise<boolean>;
  locator(selector: string): { count(): Promise<number> };
  url(): string;
  on(event: "pageerror", f: (e: Error) => void): void;
  route(pattern: string, handler: (r: PwRoute) => Promise<void>): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(opts: { colorScheme: "light" | "dark" }): Promise<void>;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
export interface PwBrowser {
  newContext(opts?: { bypassCSP?: boolean; deviceScaleFactor?: number; viewport?: { width: number; height: number } }): Promise<PwContext>;
  close(): Promise<void>;
}
export interface Pw {
  chromium: { launch(): Promise<PwBrowser> };
}

export function loadPlaywright(): Pw | null {
  const name = process.env.PLAYWRIGHT_PATH ?? "playwright";
  try {
    return require(name) as Pw;
  } catch {
    if (Bun.which("node") === null) return null;
    const r = Bun.spawnSync(["node", "-e", `process.stdout.write(require.resolve(${JSON.stringify(name)}))`], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    try {
      return require(r.stdout.toString()) as Pw;
    } catch {
      return null;
    }
  }
}
