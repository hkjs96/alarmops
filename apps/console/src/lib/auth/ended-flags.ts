/**
 * Fixed query flags of the session-ended flow. Values are constants — never a URL, never echoed back.
 * - ENDED_FROM_LAYOUT: set only by the root layout when GET /me answered 401.
 * - LOGIN_ENDED: /auth/ended cleared a dead session → /login shows a one-line notice.
 */
export const ENDED_FROM_LAYOUT = "/auth/ended?from=layout";
export const LOGIN_ENDED = "/login?ended=1";
export const isFromLayout = (v: string | null | undefined): boolean => v === "layout";
export const isEndedFlag = (v: string | string[] | null | undefined): boolean => v === "1";
