import { notFound, redirect } from "next/navigation";
import { getApi } from "@/lib/api";
import { isHidden } from "@/lib/api/client";
import { incidentPanelPath } from "@/lib/scope";
import { isId } from "@/lib/validate";

/** Old address. The incident now opens in the scope panel at one path: /c/<customer>/<project>/<service>/incident/<id>. */
export default async function IncidentRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  let path: string;
  try {
    const inc = await (await getApi()).getIncident(id);
    path = incidentPanelPath(inc.org, inc.id);
  } catch (e) {
    if (isHidden(e)) notFound();
    throw e;
  }
  redirect(path);
}
