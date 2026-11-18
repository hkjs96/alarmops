import type { Metadata } from "next";
import { getPublicApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { VerifyChannel } from "@/lib/api/types";
import { isVerifyToken } from "@/lib/verify-token";
import { VerifyConfirm } from "./VerifyConfirm";

// The link is a credential: never sent on as a Referer, never indexed, never cached (the middleware adds the headers too).
export const metadata: Metadata = { title: "Confirm your contact · AlarmOps", referrer: "no-referrer", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Public page (no sign-in): the target of the link sent to a customer's person. Opening it only LOOKS (GET /verify/{token}
 * has no side effect, so a mail scanner or a preview cannot use the link up); the Confirm button is what consumes it.
 * What is shown is the channel being confirmed, never the address or number. One calm state for every dead link.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let channel: VerifyChannel | null = null;
  let unavailable = false;
  if (isVerifyToken(token)) {
    try {
      channel = (await getPublicApi().peekVerify(token)).channel;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) { unavailable = true; console.error("[verify] GET /verify/[token] failed"); }
    }
  }
  return (
    <div className="pub" data-testid="verify-page">
      <h1 tabIndex={-1}>Confirm your contact</h1>
      {channel ? <VerifyConfirm token={token} channel={channel} />
        : unavailable ? <p role="status" data-testid="verify-unavailable">We cannot check this link right now. Please try again in a few minutes.</p>
        : <p role="status" data-testid="verify-expired">This link has expired or was already used. If you still need to confirm, ask the person who sent you this link to send a new one.</p>}
    </div>
  );
}
