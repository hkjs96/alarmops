import { describe, expect, it, vi } from "vitest";
import { centralValues } from "./central";

const ACCT = "123456789012";
const roleIn = (p: string) => `arn:${p}:iam::${ACCT}:role/AlarmOpsCentral-Engine`;
const busIn = (p: string, r: string) => `arn:${p}:events:${r}:${ACCT}:event-bus/alarmops-central`;

describe("centralValues patterns (D-58)", () => {
  it("accepts the Seoul / aws values unchanged", () => {
    const v = centralValues({ CENTRAL_ROLE_ARN: roleIn("aws"), CENTRAL_EVENT_BUS_ARN: busIn("aws", "ap-northeast-2"), REMEDIATOR_CALLER_ROLE_ARN: roleIn("aws") });
    expect(v).toEqual({ centralRoleArn: roleIn("aws"), centralBusArn: busIn("aws", "ap-northeast-2"), remediatorCallerRoleArn: roleIn("aws") });
  });

  it("accepts other regions and the three partitions", () => {
    for (const [p, r] of [["aws", "us-east-1"], ["aws-cn", "cn-north-1"], ["aws-us-gov", "us-gov-west-1"]] as const) {
      const v = centralValues({ CENTRAL_ROLE_ARN: roleIn(p), CENTRAL_EVENT_BUS_ARN: busIn(p, r) });
      expect(v.centralRoleArn).toBe(roleIn(p));
      expect(v.centralBusArn).toBe(busIn(p, r));
    }
  });

  it("rejects malformed values (treated as missing)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = centralValues({
      CENTRAL_ROLE_ARN: `arn:evil:iam::${ACCT}:role/x`,
      CENTRAL_EVENT_BUS_ARN: busIn("aws-eu", "eu-west-1"),
      REMEDIATOR_CALLER_ROLE_ARN: "arn:aws:iam::12345:role/x",
    });
    expect(bad).toEqual({ centralRoleArn: null, centralBusArn: null, remediatorCallerRoleArn: null });
    for (const b of [
      `arn:aws:events:us east:${ACCT}:event-bus/x`,
      `arn:aws:events:us-east-1:${ACCT}:event-bus/x/y`,
      `arn:aws:events:us-east-1:${ACCT}:event-bus/`,
      `arn:aws:events:us-east-1:12345:event-bus/x`,
      `arn:aws:events::${ACCT}:event-bus/x`,
      `arn:aws:events:Us-East-1:${ACCT}:event-bus/x`,
    ]) expect(centralValues({ CENTRAL_EVENT_BUS_ARN: b }).centralBusArn).toBeNull();
    expect(centralValues({ CENTRAL_ROLE_ARN: `arn:aws:iam::${ACCT}:user/x` }).centralRoleArn).toBeNull();
  });

  it("ROLE_RE allows only the three partitions and no `..` in the path", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const arn of [
      `arn:aws-iso:iam::${ACCT}:role/x`, `arn:aws-iso-b:iam::${ACCT}:role/x`, `arn:awsfoo:iam::${ACCT}:role/x`, `arn:aws-:iam::${ACCT}:role/x`,
      `arn:aws:iam::${ACCT}:role/a/../b`, `arn:aws:iam::${ACCT}:role/..`,
    ]) expect(centralValues({ CENTRAL_ROLE_ARN: arn }).centralRoleArn).toBeNull();
    expect(centralValues({ CENTRAL_ROLE_ARN: `arn:aws:iam::${ACCT}:role/path/to/role.v1` }).centralRoleArn).not.toBeNull();
  });

  it("BUS_RE: partition and region must agree", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [p, r] of [["aws-cn", "us-east-1"], ["aws-cn", "ap-northeast-2"], ["aws-us-gov", "us-east-1"], ["aws", "cn-north-1"], ["aws", "us-gov-west-1"]] as const)
      expect(centralValues({ CENTRAL_EVENT_BUS_ARN: busIn(p, r) }).centralBusArn).toBeNull();
    expect(centralValues({ CENTRAL_EVENT_BUS_ARN: busIn("aws-cn", "cn-northwest-1") }).centralBusArn).not.toBeNull();
  });
});
