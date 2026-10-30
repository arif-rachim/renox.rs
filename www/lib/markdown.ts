// A small Markdown renderer for the repository's documentation (#326): the
// subset `docs/**` uses (ATX headings, paragraphs, lists, fenced code,
// tables, block quotes, rules, emphasis, inline code, links). Every text run
// is HTML-escaped and raw HTML is not passed through (an HTML comment is
// dropped), so the output is safe for `r-html`. Links are rewritten by
// `resolve`: a document of the site becomes its page, anything else a link
// to the repository.

const esc = (s: string): string => s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** A heading's id: GitHub's rule (lower case, punctuation dropped, spaces to dashes). */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

export type Resolve = (target: string) => string;

function inline(text: string, resolve: Resolve): string {
  // Code spans first, kept out of the other rules.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/gu, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_, label: string, target: string) => {
    const href = resolve(target);
    links.push(`<a href="${esc(href)}">${emphasis(esc(label))}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = emphasis(esc(s));
  s = s.replace(/\u0001(\d+)\u0001/gu, (_, i: string) => links[Number(i)] as string);
  // After the links, so a code span inside a link label is restored too.
  return s.replace(/\u0000(\d+)\u0000/gu, (_, i: string) => codes[Number(i)] as string);
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/gu, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/gu, "$1<em>$2</em>");
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((c) => c.trim().replace(/\\\|/gu, "|"));

export interface Rendered {
  html: string;
  title: string;
  headings: { level: number; text: string; id: string }[];
}

/** Renders `md`; `resolve` maps each link target to its href. */
export function render(md: string, resolve: Resolve = (t) => t): Rendered {
  const lines = md.replace(/\r\n?/gu, "\n").replace(/<!--[\s\S]*?-->/gu, "").split("\n");
  const out: string[] = [];
  const headings: Rendered["headings"] = [];
  const used = new Map<string, number>();
  let title = "";
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push(`<p>${inline(para.join(" "), resolve)}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/u.exec(line);
    if (fence !== null) {
      flush();
      const close = fence[2] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(close)) body.push(lines[i++] as string);
      i++;
      const lang = fence[3] === "" ? "" : ` class="language-${esc(fence[3] as string)}"`;
      out.push(`<pre><code${lang}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (h !== null) {
      flush();
      const level = (h[1] as string).length;
      const text = h[2] as string;
      let id = slugOf(text.replace(/`/gu, ""));
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n > 0) id = `${id}-${n}`;
      if (level === 1 && title === "") title = text.replace(/`/gu, "");
      headings.push({ level, text: text.replace(/`/gu, ""), id });
      out.push(`<h${level} id="${esc(id)}">${inline(text, resolve)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/u.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|?\s*:?-{3,}/u.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/u.test(lines[i] as string)) rows.push(cells(lines[i++] as string));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, resolve)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, resolve)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*>/u.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/u.test(lines[i] as string)) body.push((lines[i++] as string).replace(/^\s*>\s?/u, ""));
      out.push(`<blockquote>${render(body.join("\n"), resolve).html}</blockquote>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (item !== null) {
      flush();
      // A list block: this item and every following line that is an item or indented under one.
      const block: string[] = [];
      while (i < lines.length && ((lines[i] as string).trim() === "" ? /^\s+\S|^\s*([-*+]|\d+[.)])\s/u.test(lines[i + 1] ?? "") : /^\s*([-*+]|\d+[.)])\s|^\s+\S/u.test(lines[i] as string))) block.push(lines[i++] as string);
      out.push(list(block, resolve));
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join("\n"), title, headings };
}

/** A list and the lists nested under its items (by indentation). */
function list(block: string[], resolve: Resolve): string {
  const first = /^(\s*)([-*+]|\d+[.)])\s/u.exec(block[0] as string);
  const indent = (first?.[1] ?? "").length;
  const ordered = /\d/u.test(first?.[2] ?? "");
  const items: string[][] = [];
  for (const l of block) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(l);
    if (m !== null && (m[1] as string).length === indent) items.push([m[3] as string]);
    else items.at(-1)?.push(l);
  }
  const body = items
    .map(([head, ...rest]) => {
      const nested = rest.filter((l) => l.trim() !== "");
      const sub = nested.findIndex((l) => /^\s*([-*+]|\d+[.)])\s/u.test(l));
      const text = [head, ...(sub === -1 ? nested : nested.slice(0, sub)).map((l) => l.trim())].join(" ");
      return `<li>${inline(text as string, resolve)}${sub === -1 ? "" : list(nested.slice(sub), resolve)}</li>`;
    })
    .join("");
  return ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`;
}
