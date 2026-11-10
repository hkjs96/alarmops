import { notFound } from "next/navigation";
import type { SP } from "@/lib/query";
import { parseCallOrderRoute, parsePanelRoute } from "@/lib/scope";
import { CallOrderScreen } from "../../../call-order/CallOrderScreen";
import { IncidentsScreen } from "../../../incidents/IncidentsScreen";

/**
 * Panel route. The path is the panel's own scope and nothing else:
 *   /c/<customer>/<project>/<service>/incident/<id>      ("-" in place of the customer = unmapped account)
 *   /c/<customer>[/<project>[/<service>]]/call-order     (the call order of exactly that level)
 * The query is the reader's list filter. Reload, back and forward restore both. Anything that does not resolve —
 * unknown customer, project, service or id, a path that is not the incident's own, or something the user may not
 * see — is the same Not found.
 */
export default async function PanelPage({ params, searchParams }: { params: Promise<{ customer: string; path?: string[] }>; searchParams: Promise<SP> }) {
  const { customer, path } = await params;
  const co = parseCallOrderRoute(customer, path);
  if (co) return <CallOrderScreen sp={await searchParams} panel={co} />;
  const route = parsePanelRoute(customer, path);
  if (!route) notFound();
  return <IncidentsScreen sp={await searchParams} panel={route} />;
}
