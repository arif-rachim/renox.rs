// Runtime of render path B (renox-template src/emit_js). It reproduces the
// renderer of path A (src/render, src/filters) on JavaScript values: the
// loader's data as it is, without marshaling. Byte-equal output on the
// fixture set is tested in tests/emit_js.rs.

/** Defaults of RenderLimits::DEFAULT (src/render/mod.rs). */
const MAX_ITERATIONS = 100000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_DEPTH = 8;

class RenderLimitError extends Error {
  constructor(limit) {
    super(`render ${limit} limit`);
    this.code = "RENOX_RENDER_LIMIT";
    this.limit = limit;
  }
}

/** A string that is printed without escaping (`| safe`, `| json`). */
class Safe {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

const hasOwn = Object.prototype.hasOwnProperty;
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Safe);
const isStr = (v) => typeof v === "string" || v instanceof Safe;
const plain = (v) => (v instanceof Safe ? v.s : v);
const sortedKeys = (o) => Object.keys(o).sort(cmpStr);

/** Rust `str` order (code points), not UTF-16 code units. */
function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      if (x >= 0xd800 && x < 0xe000 && !(y >= 0xd800 && y < 0xe000) && y >= 0xe000) return 1;
      if (y >= 0xd800 && y < 0xe000 && !(x >= 0xd800 && x < 0xe000) && x >= 0xe000) return -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

// --- Printing ---------------------------------------------------------------

/** Rust's `f64` Display: shortest round-trip digits, never an exponent. */
function rustFloat(n) {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n < 0 ? "-inf" : "inf";
  let s = String(n);
  const e = s.indexOf("e");
  if (e >= 0) {
    const neg = s[0] === "-";
    const mant = s.slice(neg ? 1 : 0, e).replace(".", "");
    const dot = (s.indexOf(".") >= 0 ? s.indexOf(".") - (neg ? 1 : 0) : e - (neg ? 1 : 0)) + Number(s.slice(e + 1));
    if (dot <= 0) s = "0." + "0".repeat(-dot) + mant;
    else if (dot >= mant.length) s = mant + "0".repeat(dot - mant.length);
    else s = mant.slice(0, dot) + "." + mant.slice(dot);
    if (neg) s = "-" + s;
  }
  return s;
}

/**
 * A JS number as minijinja prints it. The loader's data reaches path A as
 * JSON: an integral number is an integer there (up to the u64/i64 range),
 * anything else an f64, which prints with a `.0` when it has no fraction.
 */
function numStr(n) {
  if (Number.isInteger(n) && n <= 18446744073709551615 && n >= -9223372036854775808) {
    return Math.abs(n) < 1e21 ? String(n) : BigInt(n).toString();
  }
  const s = rustFloat(n);
  return /^-?\d+$/.test(s) ? s + ".0" : s;
}

/** minijinja's `Value` Display. */
function str(v) {
  switch (typeof v) {
    case "string":
      return v;
    case "number":
      return numStr(v);
    case "boolean":
      return v ? "True" : "False";
    case "undefined":
      return "";
  }
  if (v === null) return "None";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return "[" + v.map(repr).join(", ") + "]";
  return "{" + sortedKeys(v).map((k) => repr(k) + ": " + repr(v[k])).join(", ") + "}";
}

/** Rust's `f64` Debug: an exponent below 1e-4 and from 1e16. */
function rustFloatDebug(n) {
  const a = Math.abs(n);
  if (a !== 0 && Number.isFinite(a) && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = n.toExponential().split("e");
    return m + "e" + (e[0] === "+" ? e.slice(1) : e);
  }
  const s = rustFloat(n);
  return /^-?\d+$/.test(s) ? s + ".0" : s;
}

/** A string as minijinja's Debug quotes it (Python style). */
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === q) out += "\\" + ch;
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + q;
}

/** minijinja's `Value` Debug, used inside sequences and maps. */
function repr(v) {
  if (isStr(v)) return pyRepr(plain(v));
  if (v === undefined) return "undefined";
  if (typeof v === "number" && !(Number.isInteger(v) && Math.abs(v) <= 18446744073709551615)) return rustFloatDebug(v);
  return str(v);
}

function escapeHtml(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

// --- Values -------------------------------------------------------------------

/** minijinja truthiness. */
function truthy(v) {
  switch (typeof v) {
    case "boolean":
      return v;
    case "number":
      return v !== 0;
    case "string":
      return v.length > 0;
    case "undefined":
      return false;
  }
  if (v === null) return false;
  if (v instanceof Safe) return v.s.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  for (const k in v) if (hasOwn.call(v, k)) return true;
  return false;
}

/** `a.b` and `a[k]` with chainable undefined: a missing key is undefined. */
function getItem(o, k) {
  if (o === undefined || o === null || typeof o !== "object") {
    if (typeof o === "string" && typeof k === "number" && Number.isInteger(k)) {
      const cs = [...o];
      return cs[k < 0 ? cs.length + k : k];
    }
    return undefined;
  }
  if (Array.isArray(o)) {
    if (typeof k !== "number" || !Number.isInteger(k)) return undefined;
    return o[k < 0 ? o.length + k : k];
  }
  if (o instanceof Safe) return getItem(o.s, k);
  if (typeof k !== "string") return undefined;
  return hasOwn.call(o, k) ? o[k] : undefined;
}

function mapOf(pairs) {
  const m = {};
  for (const [k, v] of pairs) m[str(k)] = v;
  return m;
}

const kindRank = (v) =>
  v === undefined ? 0 : v === null ? 1 : typeof v === "boolean" ? 2 : typeof v === "number" ? 3 : isStr(v) ? 4 : Array.isArray(v) ? 6 : 7;

function eq(a, b) {
  a = plain(a);
  b = plain(b);
  if (a === b) return true;
  const ka = kindRank(a);
  const kb = kindRank(b);
  if ((ka === 2 || ka === 3) && (kb === 2 || kb === 3)) return Number(a) === Number(b);
  if (ka !== kb) return false;
  if (ka === 6) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (ka === 7) {
    const ak = Object.keys(a);
    return ak.length === Object.keys(b).length && ak.every((k) => hasOwn.call(b, k) && eq(a[k], b[k]));
  }
  return false;
}

/** minijinja's total order: by kind first, then by value. */
function cmp(a, b) {
  a = plain(a);
  b = plain(b);
  const ka = kindRank(a);
  const kb = kindRank(b);
  if (ka !== kb) {
    if ((ka === 2 || ka === 3) && (kb === 2 || kb === 3)) return Number(a) - Number(b);
    return ka - kb;
  }
  switch (ka) {
    case 2:
    case 3:
      return Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0;
    case 4:
      return cmpStr(a, b);
    case 6:
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = cmp(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length - b.length;
    case 7: {
      const x = sortedKeys(a).map((k) => [k, a[k]]);
      const y = sortedKeys(b).map((k) => [k, b[k]]);
      return cmp(x, y);
    }
  }
  return 0;
}

const ne = (a, b) => !eq(a, b);
const lt = (a, b) => cmp(a, b) < 0;
const le = (a, b) => cmp(a, b) <= 0;
const gt = (a, b) => cmp(a, b) > 0;
const ge = (a, b) => cmp(a, b) >= 0;

function num(v, op) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`unable to calculate ${op}: not a number`);
}

function add(a, b) {
  if (isStr(a) && isStr(b)) return plain(a) + plain(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  return num(a, "+") + num(b, "+");
}
const sub = (a, b) => num(a, "-") - num(b, "-");
const mul = (a, b) => num(a, "*") * num(b, "*");
const div = (a, b) => num(a, "/") / num(b, "/");
const floorDiv = (a, b) => Math.floor(num(a, "//") / num(b, "//"));
const rem = (a, b) => num(a, "%") % num(b, "%");
const pow = (a, b) => num(a, "**") ** num(b, "**");
const neg = (a) => -num(a, "-");
const concat = (a, b) => str(a) + str(b);

function contains(container, item) {
  container = plain(container);
  if (typeof container === "string") return container.includes(str(item));
  if (Array.isArray(container)) return container.some((x) => eq(x, item));
  if (isMap(container)) return isStr(item) && hasOwn.call(container, plain(item));
  throw new Error("cannot perform a containment check on this value");
}
const notContains = (container, item) => !contains(container, item);

/** The items a `for` loop visits: map keys in order, string characters. */
function iter(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  if (isStr(v)) return [...plain(v)];
  if (typeof v === "object") return sortedKeys(v);
  throw new Error(`${typeof v} is not iterable`);
}

function len(v) {
  if (Array.isArray(v)) return v.length;
  if (isStr(v)) return [...plain(v)].length;
  if (isMap(v)) return Object.keys(v).length;
  return undefined;
}

function loopVar(i, n) {
  return {
    index: i + 1,
    index0: i,
    revindex: n - i,
    revindex0: n - i - 1,
    first: i === 0,
    last: i === n - 1,
    length: n,
    depth: 1,
    depth0: 0,
  };
}

// --- Output and limits ----------------------------------------------------------

class Out {
  constructor(cx) {
    this.s = "";
    this.cx = cx;
    this.n = 0;
    this.depth = 0;
    this.maxIterations = cx.maxIterations ?? MAX_ITERATIONS;
    this.maxOutput = cx.maxOutputBytes ?? MAX_OUTPUT;
    this.locale = parseLocale(cx.locale);
  }
  w(s) {
    this.s += s;
  }
  /** src/render/mod.rs format_value. */
  emit(v) {
    if (v === undefined || v === null) return;
    if (typeof v === "string") this.s += escapeHtml(v);
    else if (v instanceof Safe) this.s += v.s;
    else this.s += escapeHtml(str(v));
  }
  /** `__loop`: counts iterations; checks the output size at every loop. */
  loop(v) {
    this.n += len(v) ?? 0;
    if (this.n > this.maxIterations) throw new RenderLimitError("iterations");
    if (this.s.length > this.maxOutput) throw new RenderLimitError("output");
    return v;
  }
}

function can(o, action, resource) {
  return typeof o.cx.can === "function" && o.cx.can(str(action), resource) === true;
}

// --- Filters (src/filters/mod.rs) --------------------------------------------------

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function parseLocale(tag) {
  const lower = String(tag ?? "en-AE").toLowerCase();
  return {
    ar: lower === "ar" || lower.startsWith("ar-"),
    arabicDigits: lower.includes("-u-nu-arab"),
  };
}

const isMissing = (v) => v === undefined || v === null;

function toF64(v, filter) {
  let n = null;
  if (typeof v === "number") n = v;
  else if (isStr(v)) {
    const t = plain(v).trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) || /^[+-]?(inf|infinity|nan)$/i.test(t)) n = Number(t);
  }
  if (n === null || !Number.isFinite(n)) throw new Error(`\`${filter}\` needs a number`);
  return n;
}

/** Rust `format!("{:.d}", x)` for x >= 0: exact value, ties to even. */
function fixed(x, d) {
  if (x >= 1e21) return BigInt(x).toString() + (d > 0 ? "." + "0".repeat(d) : "");
  let s = x.toFixed(d);
  // An exact tie (x * 10^d ends in .5) is rounded up by toFixed; Rust
  // keeps the even digit. It is a tie exactly when x * 2^(d+1) is odd.
  const z = x * 2 ** (d + 1);
  if (Number.isInteger(z) && z % 2 === 1) {
    const last = s.charCodeAt(s.length - 1) - 48;
    if (last % 2 === 1) s = s.slice(0, -1) + String(last - 1);
  }
  return s;
}

function localizeDigits(s, locale) {
  return locale.arabicDigits ? s.replace(/[0-9]/g, (c) => ARABIC_DIGITS[c.charCodeAt(0) - 48]) : s;
}

function formatNumber(n, decimals, locale) {
  let fixedStr;
  if (decimals === null) {
    fixedStr = fixed(Math.abs(n), 3).replace(/0+$/, "").replace(/\.$/, "");
  } else {
    fixedStr = fixed(Math.abs(n), decimals);
  }
  const dot = fixedStr.indexOf(".");
  const int = dot >= 0 ? fixedStr.slice(0, dot) : fixedStr;
  const frac = dot >= 0 ? fixedStr.slice(dot + 1) : null;
  const [group, decimal, minus] = locale.arabicDigits ? ["٬", "٫", "؜-"] : [",", ".", "-"];
  let grouped = "";
  for (let i = 0; i < int.length; i++) {
    if (i > 0 && (int.length - i) % 3 === 0) grouped += group;
    grouped += int[i];
  }
  let out = "";
  if (n < 0 && !/^[0.]*$/.test(fixedStr)) out += minus;
  out += grouped;
  if (frac !== null) out += decimal + frac;
  return localizeDigits(out, locale);
}

function currencySymbol(code, ar) {
  if (code === "AED") return ar ? "د.إ." : "AED";
  if (code === "SAR" && ar) return "ر.س.";
  if (code === "USD") return "US$";
  if (code === "EUR") return "€";
  return code;
}

/** Characters (code points) of a string, as Rust's `chars()`. */
const chars = (s) => [...s];

const F = {
  money(o, v, currency) {
    if (isMissing(v)) return "";
    const n = toF64(v, "money");
    const code = currency === undefined || currency === null ? "AED" : str(currency);
    if (!/^[A-Z]{3}$/.test(code)) throw new Error("`money` needs an ISO 4217 code");
    const amount = formatNumber(n, 2, o.locale);
    const symbol = currencySymbol(code, o.locale.ar);
    return o.locale.ar ? `${amount} ${symbol}` : `${symbol} ${amount}`;
  },
  number(o, v, decimals) {
    if (isMissing(v)) return "";
    const n = toF64(v, "number");
    return formatNumber(n, decimals === undefined || decimals === null ? null : Math.min(decimals, 10), o.locale);
  },
  truncate(o, v, length, end) {
    const s = str(v);
    const max = length === undefined || length === null ? 255 : length;
    const cs = chars(s);
    if (cs.length <= max) return v;
    return cs.slice(0, max).join("").trimEnd() + (end === undefined || end === null ? "…" : str(end));
  },
  json(o, v) {
    const s = JSON.stringify(sortValue(v) ?? null);
    return new Safe(s.replace(/[<>&']/g, (c) => "\\u00" + c.charCodeAt(0).toString(16).padStart(2, "0")));
  },
  upper(o, v) {
    return str(v).toUpperCase();
  },
  lower(o, v) {
    return str(v).toLowerCase();
  },
  default(o, v, other, lax) {
    const fallback = other === undefined ? "" : other;
    return v === undefined || (truthy(lax) && !truthy(v)) ? fallback : v;
  },
  length(o, v) {
    const n = len(v);
    if (n === undefined) throw new Error("cannot calculate length of this value");
    return n;
  },
  first(o, v) {
    if (isStr(v)) return chars(plain(v))[0];
    if (Array.isArray(v)) return v[0];
    if (isMap(v)) return sortedKeys(v)[0];
    throw new Error("cannot get first item from value");
  },
  last(o, v) {
    if (isStr(v)) {
      const cs = chars(plain(v));
      const c = cs[cs.length - 1];
      return c !== undefined && v instanceof Safe ? new Safe(c) : c;
    }
    if (Array.isArray(v)) return v[v.length - 1];
    throw new Error("cannot get last item from value");
  },
  join(o, v, sep) {
    const j = sep === undefined || sep === null ? "" : str(sep);
    return iter(v).map((x) => (isStr(x) ? plain(x) : str(x))).join(j);
  },
  trim(o, v) {
    const t = str(v).trim();
    return v instanceof Safe ? new Safe(t) : t;
  },
  abs(o, v) {
    if (typeof v !== "number") throw new Error("cannot get absolute value");
    return Math.abs(v);
  },
  safe(o, v) {
    return new Safe(str(v));
  },
  /** src/filters/mod.rs url: only relative, http(s), mailto, tel. */
  __url(o, v) {
    const s = str(v);
    const squeezed = s.replace(/[\t\n\r]/g, "");
    const trimmed = squeezed.replace(/^[\u0000- ]+/, "");
    const m = /[:/?#]/.exec(trimmed);
    if (m && m[0] === ":") {
      const scheme = trimmed.slice(0, m.index).toLowerCase();
      if (!["http", "https", "mailto", "tel"].includes(scheme)) return "about:invalid#renox-unsafe-url";
    }
    return s;
  },
};

/** Maps with sorted keys, as minijinja's BTreeMap serializes them. */
function sortValue(v) {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of sortedKeys(v)) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

const isInt = (v) => typeof v === "number" && Number.isInteger(v);

const TESTS = {
  defined: (v) => v !== undefined,
  undefined: (v) => v === undefined,
  none: (v) => v === null,
  true: (v) => v === true,
  false: (v) => v === false,
  number: (v) => typeof v === "number",
  string: (v) => isStr(v),
  sequence: (v) => Array.isArray(v),
  mapping: (v) => isMap(v),
  even: (v) => isInt(v) && v % 2 === 0,
  odd: (v) => isInt(v) && Math.abs(v % 2) === 1,
  divisibleby: (v, n) => isInt(v) && isInt(n) && n !== 0 && v % n === 0,
  eq: (a, b) => eq(a, b),
  ne: (a, b) => !eq(a, b),
  lt: (a, b) => lt(a, b),
  le: (a, b) => le(a, b),
  gt: (a, b) => gt(a, b),
  ge: (a, b) => ge(a, b),
  in: (v, c) => contains(c, v),
  startingwith: (v, p) => isStr(v) && plain(v).startsWith(str(p)),
  endingwith: (v, p) => isStr(v) && plain(v).endsWith(str(p)),
};

// --- Templates ----------------------------------------------------------------

/** The block table of a template: its blocks over its parents'. */
function chainOf(T, id) {
  const t = T[id];
  if (!t) throw new Error(`unknown template ${id}`);
  if (t.chain) return t.chain;
  const list = [];
  for (let x = t, depth = 0; x; x = x.parent === null ? null : T[x.parent]) {
    if (++depth > MAX_DEPTH) throw new RenderLimitError("depth");
    list.push(x);
  }
  const B = Object.create(null);
  for (let i = list.length - 1; i >= 0; i--) Object.assign(B, list[i].blocks);
  t.chain = { root: list[list.length - 1], B, depth: list.length - 1 };
  return t.chain;
}

function include(T, id, s, o) {
  const c = chainOf(T, id);
  o.depth += 1 + c.depth;
  if (o.depth > MAX_DEPTH) throw new RenderLimitError("depth");
  c.root.body(s, o, c.B);
  o.depth -= 1 + c.depth;
}

/** The root scope: the platform value `__renox` over the tenant's data. */
function rootScope(data, cx) {
  const s = Object.create(null);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    for (const k of Object.keys(data)) s[k] = data[k];
  }
  s.__renox = { csp_nonce: cx.csp_nonce ?? null, csrf_token: cx.csrf_token ?? null };
  return s;
}

function renderTemplate(T, id, block, data, cx) {
  cx = cx ?? {};
  const c = chainOf(T, id);
  const o = new Out(cx);
  o.depth = c.depth;
  const s = rootScope(data, cx);
  if (block === null) {
    c.root.body(s, o, c.B);
  } else {
    const b = c.B[block];
    if (!b) throw new Error(`unknown fragment ${block} of ${id}`);
    b(s, o, c.B);
  }
  if (o.s.length > o.maxOutput) throw new RenderLimitError("output");
  return o.s;
}
