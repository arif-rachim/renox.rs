// The SVG sanitiser on a corpus of hostile SVGs (#332; docs/23 "Storage",
// "SVG with script"): each one comes out without anything that runs, loads
// or navigates, or is refused (null). No worker needed.
import { expect, test } from "bun:test";

import { sanitizeSvg } from "../lib/core.ts";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** Name and SVG; every entry carries at least one live payload. */
const CORPUS: [string, string][] = [
  ["script element", `<svg ${NS}><script>alert(1)</script></svg>`],
  ["script with CDATA", `<svg ${NS}><script><![CDATA[alert(1)]]></script></svg>`],
  ["self-closing script with href", `<svg ${NS}><script href="https://evil/x.js"/></svg>`],
  ["namespaced script", `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`],
  ["split tag joined by a removal", `<svg ${NS}><scr<script></script>ipt>alert(1)</script></svg>`],
  ["split opening tag", `<svg ${NS}><scr<script x>ipt>alert(1)</svg>`],
  ["upper-case script", `<svg ${NS}><SCRIPT>alert(1)</SCRIPT></svg>`],
  ["closing tag with space", `<svg ${NS}><script>alert(1)</script ></svg>`],
  ["onload on the root", `<svg ${NS} onload="alert(1)"/>`],
  ["onload after a slash", `<svg/onload=alert(1) ${NS}></svg>`],
  ["handler after a quote", `<svg ${NS}><rect width="1"onclick="alert(1)"/></svg>`],
  ["unquoted handler", `<svg ${NS}><rect onmouseover=alert(1) /></svg>`],
  ["mixed-case handler", `<svg ${NS}><rect OnClIcK="alert(1)"/></svg>`],
  ["namespaced handler", `<svg ${NS}><rect ev:onclick="alert(1)"/></svg>`],
  ["javascript link", `<svg ${NS}><a href="javascript:alert(1)"><text>x</text></a></svg>`],
  ["xlink javascript link", `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)">x</a></svg>`],
  ["unquoted javascript link", `<svg ${NS}><a href=javascript:alert(1)>x</a></svg>`],
  ["entity-encoded javascript", `<svg ${NS}><a href="&#106;avascript:alert(1)">x</a></svg>`],
  ["data html link", `<svg ${NS}><a href="data:text/html,<script>alert(1)</script>">x</a></svg>`],
  ["external use", `<svg ${NS}><use href="https://evil/sprite.svg#a"/></svg>`],
  ["external image", `<svg ${NS}><image href="https://evil/track.png"/></svg>`],
  ["foreignObject with html", `<svg ${NS}><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject></svg>`],
  ["iframe", `<svg ${NS}><iframe src="https://evil"></iframe></svg>`],
  ["embed and object", `<svg ${NS}><embed src="https://evil/x.swf"/><object data="https://evil/x"></object></svg>`],
  ["animate to javascript", `<svg ${NS}><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`],
  ["set to javascript", `<svg ${NS}><a><set attributeName="href" to="javascript:alert(1)"/>x</a></svg>`],
  ["handler element", `<svg ${NS} xmlns:ev="http://www.w3.org/2001/xml-events"><handler type="application/ecmascript" ev:event="load">alert(1)</handler></svg>`],
  ["external url() in fill", `<svg ${NS}><rect fill="url(https://evil/p.svg#g)"/></svg>`],
  ["external url() in style", `<svg ${NS}><rect style="fill:url('https://evil/p')"/></svg>`],
  ["@import in style", `<svg ${NS}><style>@import url(https://evil/x.css); rect{fill:red}</style></svg>`],
  ["expression in style", `<svg ${NS}><style>rect{width:expression(alert(1))}</style></svg>`],
  ["doctype with entity", `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${NS}><text>&x;</text></svg>`],
  ["comment before the root", `<!-- logo --><svg ${NS}><script>alert(1)</script></svg>`],
  ["vbscript link", `<svg ${NS}><a href="vbscript:msgbox(1)">x</a></svg>`],
];

/** What must not be left in a sanitised file. */
const BAD = [
  /<\/?\s*(?:[\w.-]+:)?(?:script|foreignObject|iframe|object|embed|animate|set|handler)\b/iu,
  /[\s/"'](?:[\w.-]+:)?on[a-z]+\s*=/iu,
  /(?:java|vb)script\s*:/iu,
  /&#0*106;avascript/iu,
  /data\s*:\s*text\/html/iu,
  /(?:href|src|data)\s*=\s*["']?\s*https?:/iu,
  /url\(\s*['"]?\s*https?:/iu,
  /@import/iu,
  /expression\s*\(/iu,
  /<!ENTITY|SYSTEM\s+"file:/iu,
];

for (const [name, svg] of CORPUS) {
  test(`hostile SVG: ${name}`, () => {
    const out = sanitizeSvg(svg);
    if (out === null) return;
    for (const re of BAD) expect({ name, out, match: re.test(out) ? re.source : null }).toEqual({ name, out, match: null });
    expect(out).toMatch(/^<(\?xml|!--|svg)/iu);
  });
}

test("a clean SVG keeps its shapes, fragment references and styles", () => {
  const svg = `<svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><style>rect{stroke:#000}</style><rect width="10" height="10" fill="url(#g)"/><use href="#g"/><text>Contact only</text></svg>`;
  expect(sanitizeSvg(svg)).toBe(svg);
});
