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
  export interface QueuedPhoto {
    id: number;
    user_id: string;
    job_id: string;
    phase: "before" | "after";
    caption: string;
    blob: Blob | null;
    type: string;
    size: number;
    taken_at: number;
    action_id: string;
    state: "pending" | "uploaded" | "refused";
    attempts?: number;
    refused_reason?: string;
    refused_message?: string;
  }
  export type PhotoOutcome =
    | { kind: "continue" }
    | { kind: "ok"; adjusted: boolean }
    | { kind: "auth" }
    | { kind: "retry" }
    | { kind: "refused"; stop: "none" | "job"; reason: string; message: string };
  export type PhotoAnswer = { status: number; body: unknown; signedIn?: boolean } | null;
  export interface PhotoIo {
    signed(photo: QueuedPhoto): Promise<PhotoAnswer> | PhotoAnswer;
    put(photo: QueuedPhoto, url: string): Promise<PhotoAnswer> | PhotoAnswer;
    post(photo: QueuedPhoto, key: string): Promise<PhotoAnswer> | PhotoAnswer;
  }
  export type Item = { kind: "action"; record: QueuedAction } | { kind: "photo"; record: QueuedPhoto };
  export type Answer = { status: number; body: unknown } | null;
  export type Outcome = { kind: "ok"; adjusted: boolean } | { kind: "auth" } | { kind: "retry" } | { kind: "refused"; stop: "job"; reason: string; message: string; errors?: Record<string, string> };
  export const LIMIT: number;
  export const OLD_MS: number;
  export const BACKOFF_MS: number[];
  export const POLL_MS: number;
  export const PHOTO_LIMIT: number;
  export const MIN_FREE_BYTES: number;
  export const MAX_SIDE: number;
  export const JPEG_QUALITY: number;
  export const MAX_PHOTO_BYTES: number;
  export const PHOTO_CONTENT: string[];
  export const ACTIONS: string[];
  export function actionIdOf(uuid: string): string;
  export function backoffMs(attempts: number): number;
  export function canQueue(pending: number): boolean;
  export function isOld(performedAt: number, now: number): boolean;
  export function targetOf(record: unknown): { job_id: string; action: string } | null;
  export function split(records: QueuedAction[], userId: string): { mine: QueuedAction[]; other: number; refused: QueuedAction[] };
  export function blockedJobs(records: QueuedAction[], userId: string, photos?: QueuedPhoto[]): Set<string>;
  export function nextAction(records: QueuedAction[], userId: string, also?: string[]): QueuedAction | null;
  export function behindRefused(records: QueuedAction[], userId: string, photos?: QueuedPhoto[]): QueuedAction[];
  export function outcomeOf(answer: Answer | undefined): Outcome;
  export function settle(record: QueuedAction, outcome: Outcome): { patch: Partial<QueuedAction>; stop: "none" | "job" | "all" };
  export function retryAt(now: number, record?: { attempts?: number } | null): number;
  export function replay(records: QueuedAction[], userId: string, send: (record: QueuedAction) => Promise<Answer> | Answer): Promise<{ log: { seq: number; outcome: string; patch: Partial<QueuedAction> }[]; stopped: string; records: QueuedAction[] }>;
  export function pendingPhotos(photos: QueuedPhoto[]): number;
  export function canTakePhoto(pending: number): boolean;
  export function hasRoom(estimate: { quota?: number; usage?: number } | null | undefined): boolean;
  export function fitSize(width: number, height: number): { width: number; height: number; resize: boolean };
  export function tooLarge(size: number): boolean;
  export function splitPhotos(photos: QueuedPhoto[], userId: string): { mine: QueuedPhoto[]; other: number; refused: QueuedPhoto[] };
  export function merge(records: QueuedAction[], photos: QueuedPhoto[], userId: string, held?: Iterable<number>): Item[];
  export function nextItem(records: QueuedAction[], photos: QueuedPhoto[], userId: string, also?: string[], held?: Iterable<number>): Item | null;
  export function photoOutcomeOf(step: "url" | "put" | "post", answer: PhotoAnswer | undefined): PhotoOutcome;
  export function sendPhoto(photo: QueuedPhoto, io: PhotoIo): Promise<PhotoOutcome>;
  export function settlePhoto(photo: QueuedPhoto, outcome: PhotoOutcome): { patch: Partial<QueuedPhoto>; stop: "none" | "job" | "all" };
  export function replayAll(
    records: QueuedAction[],
    photos: QueuedPhoto[],
    userId: string,
    send: (record: QueuedAction) => Promise<Answer> | Answer,
    sendOne: (photo: QueuedPhoto) => Promise<PhotoOutcome> | PhotoOutcome,
  ): Promise<{ log: { kind: "action" | "photo"; id: number; outcome: string; patch: Record<string, unknown> }[]; stopped: string; records: QueuedAction[]; photos: QueuedPhoto[] }>;
  export function dubai(ms: number): string;
  export function fill(text: string, values: Record<string, string | number>): string;
}
