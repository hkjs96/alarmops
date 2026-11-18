import { notFound } from "next/navigation";
import { getApi } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import { Card, EmptyState } from "@alarmops/design-system";
import type { Role, UserItem, UserKind, UserListQuery, UserStatus } from "@/lib/api/types";
import { SubNav } from "@/components/SubNav";
import { isId } from "@/lib/validate";
import { staffFenceDomains } from "@/lib/users";
import type { SP } from "@/lib/query";
import { UsersScreen } from "./UsersScreen";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | "" => (allowed as readonly string[]).includes(v ?? "") ? (v as T) : "";

/**
 * Settings › Users (API-CONTRACT 8.4 #69, D-55). Only an ADMIN with all customers may read it: for everybody else the
 * API answers 403 (other staff, a narrower ADMIN) or 404 (portal user), and the page is then the same "not available"
 * page as any address the user may not see. Reads are not role-gated here: the API decides.
 */
export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const api = await getApi();
  const me = await api.me();
  if (me.kind === "CUSTOMER") notFound();

  const kind: UserKind | "" = pick(one(sp.kind), ["INTERNAL", "CUSTOMER"] as const);
  const status: UserStatus | "" = pick(one(sp.status), ["ACTIVE", "DISABLED", "PENDING"] as const);
  const role: Role | "" = pick(one(sp.role), ["ADMIN", "OPERATOR", "VIEWER"] as const);
  const customerId = isId(one(sp.customerId)) ? one(sp.customerId)! : "";
  const query: UserListQuery = { ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(role ? { role } : {}), ...(customerId ? { customerId } : {}) };

  let unavailable = me.role !== "ADMIN";
  let users: UserItem[] = [];
  let activeAdmins = 0;
  let customers: { id: string; name: string; status: "ACTIVE" | "SUSPENDED" | "TERMINATED" }[] = [];
  let error: string | null = null;
  try {
    if (unavailable) throw new ApiError(403, "FORBIDDEN", "", "");
    users = (await api.listUsers(query)).items;
    // the last-admin rule counts every active all-customer admin, whatever the list is filtered to
    activeAdmins = (await api.listUsers({ kind: "INTERNAL", role: "ADMIN", status: "ACTIVE" })).items.length;
  } catch (e) {
    // signed-in MSP staff who may not manage users (other roles, an admin with a narrower range: 403) are told so; a 404 stays the plain "not found"
    if (e instanceof ApiError && e.status === 403) unavailable = true;
    else if (isHidden(e)) notFound();
    else error = "Could not load the users. Try again.";
  }
  try {
    if (unavailable) throw new Error("skip");
    customers = (await api.scopeTree()).customers.map((c) => ({ id: c.id, name: c.name, status: c.status ?? "ACTIVE" }));
  } catch { /* the filter and the portal-user form then have no customers; the list still shows */ }

  if (unavailable) {
    return (
      <div className="page">
        <div className="ph"><div><h1 tabIndex={-1}>Users</h1></div></div>
        <SubNav />
        <Card title="Not available for your role">
          <div className="us-unavailable" data-testid="users-unavailable"><EmptyState title="Not available for your role" detail="Only admins with access to all customers can manage users." /></div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="ph"><div><h1 tabIndex={-1}>Users</h1><div className="desc">Who can sign in to AlarmOps, and what they may do. Only admins with access to all customers see this page.</div></div></div>
      <SubNav />
      <UsersScreen users={users} customers={customers} meId={me.id} activeAdmins={activeAdmins} fenceDomains={staffFenceDomains()} error={error} filters={{ kind, customerId, status, role }} />
    </div>
  );
}
