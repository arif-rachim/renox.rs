// The types of public/offline-queue-core.js (a classic script for the browser that also exports its object, so a test imports it).
declare module "*/offline-queue-core.js" {
  export interface QueuedAction {
    seq: number;
    action_id: string;
    user_id: string;
    job_id: string;
    url: string;
    action: string;
    fields: Record<string, string>;
    performed_at: number;
    state: "pending" | "sent" | "refused";
    attempts: number;
    refused_reason?: string;
    refused_message?: string;
    refused_errors?: Record<string, string>;
  }
  export type Answer = { status: number; body: unknown } | null;
  export type Outcome = { kind: "ok"; adjusted: boolean } | { kind: "auth" } | { kind: "retry" } | { kind: "refused"; stop: "job"; reason: string; message: string; errors?: Record<string, string> };
  export const LIMIT: number;
  export const OLD_MS: number;
  export const BACKOFF_MS: number[];
  export const POLL_MS: number;
  export const ACTIONS: string[];
  export function actionIdOf(uuid: string): string;
  export function backoffMs(attempts: number): number;
  export function canQueue(pending: number): boolean;
  export function isOld(performedAt: number, now: number): boolean;
  export function targetOf(record: unknown): { job_id: string; action: string } | null;
  export function split(records: QueuedAction[], userId: string): { mine: QueuedAction[]; other: number; refused: QueuedAction[] };
  export function blockedJobs(records: QueuedAction[], userId: string): Set<string>;
  export function nextAction(records: QueuedAction[], userId: string, also?: string[]): QueuedAction | null;
  export function behindRefused(records: QueuedAction[], userId: string): QueuedAction[];
  export function outcomeOf(answer: Answer | undefined): Outcome;
  export function settle(record: QueuedAction, outcome: Outcome): { patch: Partial<QueuedAction>; stop: "none" | "job" | "all" };
  export function retryAt(now: number, record?: { attempts?: number } | null): number;
  export function replay(records: QueuedAction[], userId: string, send: (record: QueuedAction) => Promise<Answer> | Answer): Promise<{ log: { seq: number; outcome: string; patch: Partial<QueuedAction> }[]; stopped: string; records: QueuedAction[] }>;
  export function dubai(ms: number): string;
  export function fill(text: string, values: Record<string, string | number>): string;
}
