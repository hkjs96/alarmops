/** MaintenanceWindow matching (suppression S-5/S-6, DATA-MODEL §3, D-17). Scope axes per Q-DM-07 proposal. */
export type MaintenanceScope = 'CUSTOMER' | 'PROJECT' | 'SERVICE' | 'ACCOUNT' | 'RESOURCE_TYPE' | 'ALERT';

export interface MaintenanceWindow {
  id: string;
  customerId: string | null; // null = all customers (MSP ADMIN)
  scopeType: MaintenanceScope;
  scopeId: string | null;
  resourceType?: string | null;
  startsAt: Date;
  endsAt: Date;
  revokedAt?: Date | null;
}

export interface MaintenanceTarget {
  customerId: string | null;
  projectId?: string | null;
  serviceId?: string | null;
  awsAccountId?: string | null;
  resourceType?: string | null;
  alertId?: string | null;
}

/** `startsAt ≤ at < endsAt`, not revoked (S-5, S-6). Org scopes inherit downwards. */
export function windowCovers(w: MaintenanceWindow, t: MaintenanceTarget, at: Date): boolean {
  if (w.revokedAt && w.revokedAt.getTime() <= at.getTime()) return false;
  if (!(w.startsAt.getTime() <= at.getTime() && at.getTime() < w.endsAt.getTime())) return false;
  if (w.endsAt.getTime() <= w.startsAt.getTime()) return false; // loader drops inverted windows
  if (w.customerId != null && w.customerId !== t.customerId) return false;
  switch (w.scopeType) {
    case 'CUSTOMER': return w.scopeId == null || w.scopeId === t.customerId;
    case 'PROJECT': return w.scopeId != null && w.scopeId === t.projectId;
    case 'SERVICE': return w.scopeId != null && w.scopeId === t.serviceId;
    case 'ACCOUNT': return w.scopeId != null && w.scopeId === t.awsAccountId;
    case 'RESOURCE_TYPE': {
      const rt = w.resourceType ?? w.scopeId;
      return rt == null || (t.resourceType != null && rt.toLowerCase() === t.resourceType.toLowerCase());
    }
    case 'ALERT': return w.scopeId != null && w.scopeId === t.alertId;
  }
}

export const coveringWindow = (ws: MaintenanceWindow[], t: MaintenanceTarget, at: Date): MaintenanceWindow | null =>
  ws.filter((w) => windowCovers(w, t, at)).sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0] ?? null;

/** API validation (S-5): ends required, ends > starts, ≤ 30 days, not already ended. Returns error message or null. */
export function validateWindow(startsAt: Date, endsAt: Date, now: Date): string | null {
  if (!(endsAt.getTime() > startsAt.getTime())) return 'endsAt must be after startsAt';
  if (endsAt.getTime() - startsAt.getTime() > 30 * 86400_000) return 'Maintenance windows can be at most 30 days';
  if (endsAt.getTime() <= now.getTime()) return 'Maintenance window has already ended';
  return null;
}
