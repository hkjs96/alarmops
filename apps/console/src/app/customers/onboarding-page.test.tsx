import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleApi } from "@/lib/api/client";
import { MOCK_USERS, createMockApi, createStore } from "@/lib/api/mock/mock-api";

const state = vi.hoisted(() => ({ sub: "usr-haeun" }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => "/customers/mirae/onboarding", notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ sub: state.sub }) }));
const store = createStore();
vi.mock("@/lib/api", () => ({ getApi: async () => createMockApi(store, undefined, MOCK_USERS[state.sub]!) }));

import Page from "./[id]/onboarding/page";

const render = async (sub: string) => {
  state.sub = sub;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "mirae" }), searchParams: Promise.resolve({ step: "connection" }) }));
};

describe("onboarding page: the ExternalId is for Admins", () => {
  it("an Admin's page carries it (control), an Operator's and a Viewer's page carry none", async () => {
    expect(await render("usr-haeun")).toMatch(/ao-[0-9a-f]{64}/);
    for (const who of ["usr-minjae", "usr-sora"]) {
      const html = await render(who);
      expect(html, who).not.toMatch(/ao-[0-9a-f]{64}/);
      expect(html, who).toContain("needs the Admin role");
    }
  });
});
