import type { SP } from "@/lib/query";
import { CallOrderScreen } from "./CallOrderScreen";

export default async function CallOrderPage({ searchParams }: { searchParams: Promise<SP> }) {
  return <CallOrderScreen sp={await searchParams} />;
}
