import { notFound, redirect } from "next/navigation";
import { getApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { incidentPanelPath } from "@/lib/scope";
import { ID_RE } from "@/lib/validate";

/** Old address. The incident now opens in the scope panel at one path: /c/<customer>/<project>/<service>/incident/<id>. */
export default async function IncidentRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID_RE.test(id)) notFound();
  let path: string;
  try {
    const inc = await (await getApi()).getIncident(id);
    path = incidentPanelPath(inc.org, inc.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  redirect(path);
}
