// GET /nested: hands the B13 template two lists of 10,000 numbers. The loader
// itself is cheap; the attack is the template's 10^8 cells.
export function load() {
  const list = Array.from({ length: 10_000 }, (_, i) => i);
  return { rows: list, cols: list };
}
