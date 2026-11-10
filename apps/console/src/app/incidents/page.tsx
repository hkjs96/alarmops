import type { SP } from "@/lib/query";
import { IncidentsScreen } from "./IncidentsScreen";

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  return <IncidentsScreen sp={await searchParams} />;
}
