"""Call sites of heaptrack's live bytes (#641), for heaptrack.sh.

  compact            stdin: demangled `heaptrack_print -F` stacks (root first,
                     bytes last); stdout: `<bytes>\t<site>`, the site being
                     the stack's last six frames of renox code (by crate
                     name or by source file name), the deepest last.
  top <sites> <n>    MB per tenant by deepest renox frame, n tenants.
  diff <a> <b> <n>   MB per tenant of a minus b, by the deepest renox frame
                     (depth 1) and by it with its renox caller (depth 2).
"""

import collections
import re
import sys

RENOX = re.compile(
    r"renox_|\((isolate|render|manager|bootstrap|manifest|loader|pool|db|registry|runtime|"
    r"storage|webhook|ai|pdf|jobs|cell|globals|trace|router|lib)\.rs\)"
)
MB = 1048576


def simplify(frame: str, width: int) -> str:
    return re.sub(r"<[^<>]*>", "", frame)[:width]


def compact() -> None:
    sites = collections.Counter()
    for line in sys.stdin:
        stack, _, value = line.rstrip("\n").rpartition(" ")
        if not value.isdigit():
            continue
        frames = stack.split(";")
        keep = [simplify(f, 90) for f in frames if RENOX.search(f)]
        keep = [k for i, k in enumerate(keep) if i == 0 or k != keep[i - 1]]
        sites[";".join(keep[-6:])] += int(value)
    for site, value in sites.items():
        print(f"{value}\t{site}")


def load(path: str, depth: int) -> collections.Counter:
    out = collections.Counter()
    for line in open(path):
        value, site = line.rstrip("\n").split("\t", 1)
        chain = site.split(";") if site else []
        out[" > ".join(chain[-depth:]) if chain else "(no renox frame)"] += int(value)
    return out


def top(path: str, n: float) -> None:
    c = load(path, 1)
    print(f"total {sum(c.values()) / n / MB:.3f} MB per tenant")
    for site, value in c.most_common(20):
        print(f"{value / n / MB:8.3f}  {site}")


def diff(a_path: str, b_path: str, n: float) -> None:
    for depth in (1, 2):
        a, b = load(a_path, depth), load(b_path, depth)
        print(f"--- depth {depth}: total {sum(a.values()) / n / MB:.3f} - {sum(b.values()) / n / MB:.3f} MB per tenant")
        for site in sorted(set(a) | set(b), key=lambda k: -abs(a[k] - b[k]))[:15]:
            print(f"{(a[site] - b[site]) / n / MB:+8.3f}  {a[site] / n / MB:7.3f} {b[site] / n / MB:7.3f}  {site}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "compact":
        compact()
    elif cmd == "top":
        top(sys.argv[2], float(sys.argv[3]))
    elif cmd == "diff":
        diff(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    else:
        sys.exit(__doc__)
