import { createHash, randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { randomId } from '@survey/core';

/** Time-ordered UUIDv7 for primary keys. */
export const newId = (): string => v7();

/** Short public identifier for survey URLs and QR codes (10 base62 chars ≈ 59 bits). */
export const newPublicId = (): string => randomId(10);

/** Opaque secret for cookies, invitation and reset links. */
export const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Only hashes of secrets are stored. */
export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
