import type { SP } from "@/lib/query";
import { MonitoringScreen } from "../MonitoringScreen";

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  return <MonitoringScreen tab="needs-review" sp={await searchParams} />;
}
