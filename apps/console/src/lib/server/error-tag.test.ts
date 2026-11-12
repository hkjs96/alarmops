import { describe, expect, it } from "vitest";
import { errorTag } from "./error-tag";

describe("errorTag", () => {
  it("logs name and pg code, never the message", () => {
    const e = Object.assign(new Error('duplicate key value (email)=(jisu@acme.example) postgres://u:pw@h/db'), { code: "23505" });
    expect(errorTag(e)).toBe("Error code=23505");
  });
  it("drops non-pg-shaped codes and non-Error values", () => {
    expect(errorTag(Object.assign(new TypeError("secret"), { code: "x; secret value" }))).toBe("TypeError");
    expect(errorTag("raw secret string")).toBe("string");
  });
});
