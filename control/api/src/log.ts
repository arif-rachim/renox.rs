// Structured operator logs: one JSON object per line on stdout. Request
// bodies, Authorization headers and secret values are never passed in; as a
// second line of defence every token-shaped string is masked before writing.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  log(level: Level, msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const TOKEN = /renox_(pat|node|op|ses)_[a-z2-7]{32}/gu;

export const maskTokens = (text: string): string => text.replace(TOKEN, "renox_$1_[redacted]");

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const log = (level: Level, msg: string, fields: Fields = {}): void => {
    write(maskTokens(JSON.stringify({ ts: Date.now(), level, msg, ...fields })));
  };
  return {
    log,
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

/** A logger that keeps lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger((line) => lines.push(line)), { lines });
}
