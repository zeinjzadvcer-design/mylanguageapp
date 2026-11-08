/**
 * Recognising a browser that has signed in to an account before.
 *
 * Failed logins are limited per account, which a stranger who knows the email
 * address could otherwise use to keep its owner locked out. A browser that has
 * signed in successfully holds this cookie, and counts in a separate bucket the
 * stranger cannot reach.
 *
 * It only chooses a rate-limit bucket and grants nothing else, so it does not
 * need to be revoked when a password changes, and a stolen one still leaves its
 * holder limited.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE_NAME = "known_device";
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function tokenFor(email: string): Buffer {
  return createHmac("sha256", process.env.SESSION_SECRET ?? "ascension-dev-secret")
    .update(`known-device:${email.trim().toLowerCase()}`)
    .digest();
}

/** Whether this request carries the cookie for this email address. */
export function isKnownDevice(req: Pick<Request, "headers">, email: string): boolean {
  const entry = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return false;

  const presented = Buffer.from(entry.slice(COOKIE_NAME.length + 1), "base64url");
  const expected = tokenFor(email);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Mark this browser as having signed in to this account. */
export function rememberDevice(res: Pick<Response, "cookie">, email: string): void {
  res.cookie(COOKIE_NAME, tokenFor(email).toString("base64url"), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/api/auth",
  });
}
