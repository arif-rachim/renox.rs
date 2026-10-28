import { expect, test } from "bun:test";

import { type Action, type ActionContext, definePage, type LoaderContext } from "../src/index.ts";

test("definePage returns the page unchanged", async () => {
  const add: Action = ({ form }) => ({ added: form.get("id"), fragments: ["cart"] });
  const page = definePage({ load: ({ session }: LoaderContext) => ({ sid: session.id }), actions: { add } });
  expect(page.actions.add).toBe(add);
  const form = new FormData();
  form.append("id", "p1");
  expect(await page.actions.add({ form } as ActionContext)).toEqual({ added: "p1", fragments: ["cart"] });
  expect(await page.load({ session: { id: "s" } } as LoaderContext)).toEqual({ sid: "s" });
});
