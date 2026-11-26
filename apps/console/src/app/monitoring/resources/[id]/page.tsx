import { redirect } from "next/navigation";

/** The resource panel is not built yet: the address leads to the Resources tab. */
export default function Page() {
  redirect("/monitoring/resources");
}
