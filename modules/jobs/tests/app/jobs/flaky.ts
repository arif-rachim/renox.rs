// A job that always fails: its runs end as dead letters.
export const schedule = "0 4 1 1 *";

export async function run() {
  throw new Error("upstream unavailable");
}
