// Preloaded by bunfig.toml for every test file. The worker writes to the tenant
// file on its own (the outbox, the minute tick of jobs/inbox-sweep.ts), and the
// tests open the same file with bun:sqlite to plant rows or read them: a plain
// connection fails at once with SQLITE_BUSY when the worker holds the write
// lock at that moment, so every connection a test opens waits up to five seconds.
import { Database } from "bun:sqlite";
import { mock } from "bun:test";

class PatientDatabase extends Database {
  constructor(...args: ConstructorParameters<typeof Database>) {
    super(...args);
    this.exec("pragma busy_timeout = 5000");
  }
}

mock.module("bun:sqlite", () => ({ Database: PatientDatabase }));
