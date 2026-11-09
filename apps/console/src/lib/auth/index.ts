import "server-only";
import { cookies } from "next/headers";
import { mockMode } from "../mode";
import { SESSION_COOKIE, sessionSecret, verifySession, type SessionPayload } from "./session";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED";
  constructor() {
    super("Sign in required.");
    this.name = "UnauthorizedError";
  }
}

export interface Session extends SessionPayload { token: string }

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const p = await verifySession(token, sessionSecret(process.env, mockMode()));
  return p && token ? { ...p, token } : null;
}

/** Call first in every server action (and anywhere a user identity is required). */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s;
}
