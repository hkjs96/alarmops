import { redirect } from "next/navigation";

/** D-26: Templates is a tab of Call order. The old address goes there. */
export default function Page() {
  redirect("/call-order/templates");
}
