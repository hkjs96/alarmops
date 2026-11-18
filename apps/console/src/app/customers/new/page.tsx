import { getApi } from "@/lib/api";
import { SubNav } from "@/components/SubNav";
import { NewCustomerForm } from "@/components/onboarding/NewCustomerForm";
import { roleAtLeast } from "@/lib/roles";

/**
 * New customer, step 1 of the onboarding wizard (docs/ui/screens/customer-onboarding.md). Creating a customer is an
 * Admin action; the later steps live at /customers/<slug>/onboarding, so the work can be left and resumed from there.
 */
export default async function Page() {
  const me = await (await getApi()).me();
  const canCreate = me.kind !== "CUSTOMER" && roleAtLeast(me.role, "ADMIN");
  return (
    <div className="page">
      <div className="ph"><div><h1 tabIndex={-1}>New customer</h1><div className="desc">Connect a customer in five steps. Each step is saved as you go, so you can leave and come back.</div></div></div>
      <SubNav />
      <NewCustomerForm canCreate={canCreate} />
    </div>
  );
}
