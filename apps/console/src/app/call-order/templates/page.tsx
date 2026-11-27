import { notFound } from "next/navigation";
import { Card, EmptyState } from "@alarmops/design-system";
import { getApi } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { ResponderTemplate, StaffSummary } from "@/lib/api/types";
import { SubNav } from "@/components/SubNav";
import { TemplatesScreen } from "./TemplatesScreen";

/**
 * Call order › Templates (API-CONTRACT §8.3 "Responder 템플릿", D-41, D-64). Reading is for all MSP staff; a portal user gets the same
 * "not found" as any address that is not theirs; staff whose range of customers is narrower get a plain "not available" (a template
 * reaches every customer). Editing is for admins: the page opens read-only for the others, with the reason on screen.
 */
export default async function Page() {
  const api = await getApi();
  const me = await api.me();
  if (me.kind === "CUSTOMER") notFound();

  let templates: ResponderTemplate[] = [];
  let staff: StaffSummary[] = [];
  let error: string | null = null;
  let unavailable = false;
  try {
    [templates, staff] = await Promise.all([api.listResponderTemplates(), api.listStaff()]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) unavailable = true;
    else if (isHidden(e)) notFound();
    else error = "Could not load the templates. Try again.";
  }

  return (
    <div className="page">
      <div className="ph"><div><h1 tabIndex={-1}>Call order</h1><div className="desc">Responder templates</div></div></div>
      <SubNav />
      {unavailable ? (
        <Card title="Not available for your range">
          <div data-testid="tpl-unavailable"><EmptyState title="Not available for your range" detail="A template reaches every customer. Only staff who can see all customers can open them." /></div>
        </Card>
      ) : <TemplatesScreen templates={templates} staff={staff} error={error} />}
    </div>
  );
}
