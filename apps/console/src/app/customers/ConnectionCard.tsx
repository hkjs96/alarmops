import Link from "next/link";
import { Card } from "@alarmops/design-system";
import { getApi } from "@/lib/api";
import type { AccountRecord, AccountStatus } from "@/lib/api/types";
import { CONNECTION_LABEL, connectionOf } from "@/lib/onboarding";
import { groupDigits, kstDateTime } from "@/lib/format";
import { StateChip } from "@/components/onboarding/ui";

/**
 * Connection of a customer: its AWS accounts with the same summary the wizard uses (`connectionOf`), and the way back into
 * the kit and the check. Accounts (and their ExternalId) are Admin-only in the API, so other staff do not get this card.
 */
export async function ConnectionCard({ customerId, slug, name }: { customerId: string; slug: string; name: string }) {
  const api = await getApi();
  let accounts: AccountRecord[] = [];
  const status: Record<string, AccountStatus | null> = {};
  let failed = false;
  try {
    accounts = await api.listAccounts(customerId);
    await Promise.all(accounts.map(async (a) => { status[a.id] = await api.getAccountStatus(a.id).catch(() => null); }));
  } catch { failed = true; }
  const base = `/customers/${slug}/onboarding`;
  return (
    <Card title="Connection" actions={<Link className="btn sm" href={`${base}?step=${accounts.length ? "connection" : "account"}`} data-testid="conn-open">{accounts.length ? "Open kit and check" : "Connect an AWS account"}</Link>}>
      {failed ? <p className="sm" style={{ margin: 0 }} data-testid="conn-failed">The accounts could not be loaded. Try again in a moment.</p>
        : accounts.length === 0 ? <p className="sm" style={{ margin: 0 }} data-testid="conn-empty">No AWS account is connected to {name} yet.</p>
        : (
          <ul className="ob-list" data-testid="conn-list">
            {accounts.map((a) => {
              const c = connectionOf(status[a.id] ?? null);
              const s = status[a.id];
              return (
                <li key={a.id} className="ob-item" data-testid="conn-account" data-conn={c}>
                  <div className="row"><b className="mono">{groupDigits(a.awsAccountId)}</b>{a.alias ? <span>{a.alias}</span> : null}{a.environment ? <span className="mono sm">{a.environment}</span> : null}
                    <StateChip tone={c === "CONNECTED" ? "ok" : c === "FAILED" ? "fail" : "wait"} label={CONNECTION_LABEL[c]} /></div>
                  <div className="sm mut">{s?.lastCheckedAt ? `Last checked ${kstDateTime(s.lastCheckedAt)}.` : "Not checked yet."}{s?.lastEventAt ? ` Last event ${kstDateTime(s.lastEventAt)}.` : " No event received yet."}</div>
                </li>
              );
            })}
          </ul>
        )}
      <p className="sm mut ob-links" style={{ marginBottom: 0, marginTop: 12 }}><Link href={`${base}?step=people`}>People and verification</Link><span aria-hidden="true">·</span><Link href={`${base}?step=organization`}>Organization</Link></p>
    </Card>
  );
}
