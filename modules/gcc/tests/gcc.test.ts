// The gcc module on the worker (#243): installed into an app, its services
// through the broker, the area autocomplete fragment (one indexed query,
// under 10 ms on the dev container), the address and phone partials in
// English and Arabic (snapshots).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The SDK helper by path: a module tree has no node_modules (its hash covers every file).
import { app, policyCases, snapshot, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("gcc", () => {
  test("installed: the seed is there, the services answer through the broker", async () => {
    const count = t.db.query<{ n: number }>("select count(*) as n from gcc__areas")[0]?.n ?? 0;
    expect(count).toBeGreaterThan(30);
    expect(await t.service("gcc").validatePhone("050 123 4567")).toEqual({ ok: true, value: "+971501234567" });
    expect(await t.service("gcc").validateEmiratesId("784-1990-1234567-5")).toEqual({ ok: false, reason: "check_digit" });
    expect(await t.service("gcc").validateTrn("100123456789012")).toEqual({ ok: true, value: "100123456789012" });
    expect(await t.service("gcc").validateTradeLicence("CN-1234567", "AE-AZ")).toEqual({ ok: true, value: "CN-1234567" });
    const dubai = (await t.service("gcc").listAreas("AE-DU")) as { name_en: string; makani: number }[];
    expect(dubai.length).toBeGreaterThan(10);
    expect(dubai.every((a) => a.makani === 1)).toBe(true);
    const found = (await t.service("gcc").findAreas("dub")) as { name_en: string }[];
    expect(found.map((a) => a.name_en)).toEqual(["Dubai Hills Estate", "Dubai Investments Park", "Dubai Marina", "Dubai Silicon Oasis"]);
    expect(((await t.service("gcc").findAreas("الخ")) as { name_en: string }[]).map((a) => a.name_en)).toEqual(["Al Khalidiyah", "Al Khan", "Business Bay"]);
    expect(await t.service("gcc").findAreas("%")).toEqual([]);
  });

  test("the area fragment for `Dub`: the list only, one indexed query, under 10 ms", async () => {
    const get = () => t.request("GET", "/gcc/areas?q=Dub", { headers: { "hx-request": "true", "hx-target": "gcc-area-list" } });
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.html.startsWith('<ul id="gcc-area-list" class="gcc-areas">')).toBe(true);
    expect(first.html.match(/<li /gu)?.length).toBe(4);
    const ms: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      await get();
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length / 2)] as number).toBeLessThan(10);
    const plan = t.db.query<{ detail: string }>(
      "explain query plan select id from gcc__areas where (name_en like 'Dub%' escape '\\' or name_ar like 'Dub%' escape '\\') and (null is null or emirate = null) order by name_en limit 20",
    );
    expect(plan.some((p) => /USING (COVERING )?INDEX gcc__areas_name_(en|ar)/u.test(p.detail))).toBe(true);
  });

  test("the address and phone partials, English and Arabic", async () => {
    const en = await t.page("/address");
    expect(en.html).toContain('<html lang="en-AE" dir="ltr">');
    expect(en.html).toContain("Emirate");
    expect(en.html).toContain('<option value="AE-DU" selected');
    snapshot(en.html, { role: "address en" });
    const ar = await t.page("/address?lang=ar");
    expect(ar.html).toContain('<html lang="ar-AE" dir="rtl">');
    expect(ar.html).toContain("الإمارة");
    snapshot(ar.html, { role: "address ar" });
  });

  policyCases(join(MODULE, "policies", "tests"));
});
