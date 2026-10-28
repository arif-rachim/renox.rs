// Where the ACME client puts HTTP-01 key authorizations so the edge can
// answer `GET /.well-known/acme-challenge/<token>` on `:80`. The worker of
// #162 answers from the files in its `[tls] acme_dir`
// (crates/renox-cell/src/worker.rs, `acme_answer`), so the default
// responder writes `<dir>/<token>` there: a directory shared with the
// workers (one host, or a shared volume). A key authorization is public by
// design (the CA fetches it over plain HTTP); it is not a secret.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ChallengeResponder {
  publish(token: string, keyAuthorization: string): Promise<void>;
  remove(token: string): Promise<void>;
}

/** RFC 8555 section 8.3: a token is base64url. Anything else is never written. */
const TOKEN = /^[A-Za-z0-9_-]{1,255}$/u;

export class DirChallengeResponder implements ChallengeResponder {
  constructor(private readonly dir: string) {}

  async publish(token: string, keyAuthorization: string): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("ACME token is not base64url");
    mkdirSync(this.dir, { recursive: true });
    // Written next to the target and renamed, so the worker never reads half a file.
    const tmp = join(this.dir, `.${token}.tmp`);
    writeFileSync(tmp, keyAuthorization, { mode: 0o644 });
    renameSync(tmp, join(this.dir, token));
  }

  async remove(token: string): Promise<void> {
    if (TOKEN.test(token)) rmSync(join(this.dir, token), { force: true });
  }
}

/** Tests: the published key authorizations by token. */
export class MemoryChallengeResponder implements ChallengeResponder {
  readonly tokens = new Map<string, string>();
  async publish(token: string, keyAuthorization: string): Promise<void> {
    this.tokens.set(token, keyAuthorization);
  }
  async remove(token: string): Promise<void> {
    this.tokens.delete(token);
  }
}
