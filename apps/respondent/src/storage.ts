/**
 * Local persistence of an in-progress response. Answers are written here on every change, so
 * closing the tab, a crash or a dead network never loses what the respondent typed.
 * Every access is wrapped: storage can be disabled (private mode, blocked site data).
 */
import type { AnswerValue } from '@survey/core';

export interface LocalState {
  key: string;
  versionId: string;
  seq: number;
  /** Highest seq the server has acknowledged. */
  ackedSeq: number;
  answers: Record<string, AnswerValue>;
  pageKey: string;
  history: string[];
  start: {
    distributionToken?: string;
    testToken?: string;
    hiddenFields: Record<string, string>;
    locale: string;
  };
}

const stateKey = (publicId: string) => `sm:${publicId}`;
const doneKey = (publicId: string) => `sm:done:${publicId}`;

export function readState(publicId: string): LocalState | null {
  try {
    const raw = localStorage.getItem(stateKey(publicId));
    return raw ? (JSON.parse(raw) as LocalState) : null;
  } catch {
    return null;
  }
}

export function writeState(publicId: string, state: LocalState): void {
  try {
    localStorage.setItem(stateKey(publicId), JSON.stringify(state));
  } catch {
    // Storage full or blocked: the server copy (saved on every page) is the fallback.
  }
}

export function clearState(publicId: string): void {
  try {
    localStorage.removeItem(stateKey(publicId));
  } catch {
    // ignore
  }
}

export function markDone(publicId: string): void {
  try {
    localStorage.setItem(doneKey(publicId), new Date().toISOString());
  } catch {
    // ignore
  }
}

export function isDone(publicId: string): boolean {
  try {
    return localStorage.getItem(doneKey(publicId)) !== null;
  } catch {
    return false;
  }
}

/** 128-bit random secret, base64url (22 chars). */
export function newResponseKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
