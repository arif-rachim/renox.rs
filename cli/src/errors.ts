// CLI errors and the exit code contract (cli/README.md, "Exit codes";
// docs/23-failure-modes.md section 3). Every failure a tenant developer can
// cause ends in one CliError: one message, where (file, line, column) when
// known, what to do (hint), and the exit code of its class.

export const EXIT = {
  OK: 0,
  /** Wrong command, usage, or arguments; not in an app folder; a folder that exists. */
  USER: 1,
  /** The app is wrong: renox.toml, route files, a syntax or build error, `renox check` errors. */
  VALIDATION: 2,
  /** The machine is wrong: no renox-worker binary, a port in use, the worker does not start. */
  ENVIRONMENT: 3,
  /** SIGINT (Ctrl-C). */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface Where {
  file?: string;
  line?: number;
  column?: number;
  hint?: string;
}

export class CliError extends Error {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly hint?: string;

  constructor(
    message: string,
    readonly exitCode: ExitCode,
    where: Where = {},
  ) {
    super(message);
    if (where.file !== undefined) this.file = where.file;
    if (where.line !== undefined) this.line = where.line;
    if (where.column !== undefined) this.column = where.column;
    if (where.hint !== undefined) this.hint = where.hint;
  }
}

export class UserError extends CliError {
  constructor(message: string, where: Where = {}) {
    super(message, EXIT.USER, where);
  }
}

export class ValidationError extends CliError {
  constructor(message: string, where: Where = {}) {
    super(message, EXIT.VALIDATION, where);
  }
}

export class EnvironmentError extends CliError {
  constructor(message: string, where: Where = {}) {
    super(message, EXIT.ENVIRONMENT, where);
  }
}

/** `file:line:col` (as much as is known), or "". */
export const location = (w: Where): string =>
  w.file ? `${w.file}${w.line !== undefined ? `:${w.line}${w.column !== undefined ? `:${w.column}` : ""}` : ""}` : "";

/** How `renox` prints an error: `renox <cmd>: <file:line:col: >message`, then the hint. */
export function formatError(cmd: string, e: CliError): string {
  const at = location(e);
  return `renox ${cmd}: ${at ? `${at}: ` : ""}${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`;
}

/** The exit code for anything thrown by a command: its class's, or 1 for an unexpected error. */
export const exitCodeOf = (e: unknown): ExitCode => (e instanceof CliError ? e.exitCode : EXIT.USER);
