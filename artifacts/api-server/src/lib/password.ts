/**
 * Password hashing.
 *
 * Native bcrypt, not bcryptjs. bcryptjs is pure JavaScript and does its work on
 * the main thread, and the API has one CPU: a few hundred sign-ins at the start
 * of a school day slowed every other request until they were done. The native
 * library runs the work on libuv's thread pool instead.
 *
 * Same algorithm, same cost, same hash format, so every password hashed by
 * bcryptjs before this still verifies (see password.test.ts).
 */

import { hash, verify } from "@node-rs/bcrypt";

/** The work factor every stored hash was made with. */
const COST = 10;

export function hashPassword(password: string): Promise<string> {
  return hash(password, COST);
}

/**
 * Whether `password` matches `passwordHash`.
 *
 * False rather than an error for a hash that cannot be read: an account with a
 * damaged hash is one nobody can sign in to, not a 500 on the login page.
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(password, passwordHash);
  } catch {
    return false;
  }
}
