import { describe, expect, it, vi } from "vitest";

const provider = vi.fn(() => async () => ({ accessKeyId: "x", secretAccessKey: "y" }));
const sqsCtor = vi.fn();
const sendSpy = vi.fn(async () => ({ MessageId: "m1" }));

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({ awsCredentialsProvider: provider }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    constructor(cfg: unknown) { sqsCtor(cfg); }
    send = sendSpy;
  },
}));

import { sqsClientFromEnv } from "./sqs-client";

const ROLE = "arn:aws:iam::123456789012:role/console";

describe("sqsClientFromEnv", () => {
  it("is undefined without AWS_ROLE_ARN (fail-closed, stays 503)", () => {
    expect(sqsClientFromEnv({})).toBeUndefined();
    expect(sqsClientFromEnv({ AWS_ROLE_ARN: "  " })).toBeUndefined();
  });

  it("calls the credentials provider with only { roleArn } and builds the client in ap-northeast-2", async () => {
    const c = sqsClientFromEnv({ AWS_ROLE_ARN: ` ${ROLE} ` })!;
    await c.send({} as never);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith({ roleArn: ROLE });
    expect(sqsCtor).toHaveBeenCalledWith({ region: "ap-northeast-2", credentials: expect.any(Function) });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
