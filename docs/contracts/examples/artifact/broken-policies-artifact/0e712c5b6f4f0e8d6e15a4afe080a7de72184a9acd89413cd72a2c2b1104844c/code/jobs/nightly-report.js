export const schedule = "0 3 * * *";
export const tz = "Asia/Dubai";
export async function run({ db, log }) {
  const rows = await db.query("select count(*) as n from app__orders where status = ?", ["open"]);
  log.info("nightly report", { open: rows[0].n });
}
