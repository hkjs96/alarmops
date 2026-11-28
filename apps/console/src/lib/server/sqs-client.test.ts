import { beforeEach, describe, expect, it, vi } from "vitest";

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
const URL_SEOUL = "https://sqs.ap-northeast-2.amazonaws.com/123456789012/alarm-commands";

beforeEach(() => { sqsCtor.mockClear(); provider.mockClear(); sendSpy.mockClear(); });

describe("sqsClientFromEnv", () => {
  it("is undefined without AWS_ROLE_ARN (fail-closed, stays 503)", () => {
    expect(sqsClientFromEnv({})).toBeUndefined();
    expect(sqsClientFromEnv({ AWS_ROLE_ARN: "  ", ALARM_COMMANDS_QUEUE_URL: URL_SEOUL })).toBeUndefined();
  });

  it("is undefined with an empty queue URL (no publisher, requests stay 503)", () => {
    expect(sqsClientFromEnv({ AWS_ROLE_ARN: ROLE })).toBeUndefined();
    expect(sqsClientFromEnv({ AWS_ROLE_ARN: ROLE, ALARM_COMMANDS_QUEUE_URL: "  " })).toBeUndefined();
  });

  it("refuses to start on a malformed queue URL", () => {
    expect(() => sqsClientFromEnv({ AWS_ROLE_ARN: ROLE, ALARM_COMMANDS_QUEUE_URL: "https://example.com/1/q" })).toThrow();
  });

  it("calls the credentials provider with only { roleArn } and builds the client in the Seoul region of the URL", async () => {
    const c = sqsClientFromEnv({ AWS_ROLE_ARN: ` ${ROLE} `, ALARM_COMMANDS_QUEUE_URL: URL_SEOUL })!;
    await c.send({} as never);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith({ roleArn: ROLE });
    expect(sqsCtor).toHaveBeenCalledWith({ region: "ap-northeast-2", credentials: expect.any(Function) });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["us-east-1", "https://sqs.us-east-1.amazonaws.com/123456789012/q"],
    ["cn-north-1", "https://sqs.cn-north-1.amazonaws.com.cn/123456789012/q"],
    ["us-gov-west-1", "https://sqs.us-gov-west-1.amazonaws.com/123456789012/q"],
  ])("builds the client in the region of the queue URL (%s)", async (region, u) => {
    const c = sqsClientFromEnv({ AWS_ROLE_ARN: ROLE, ALARM_COMMANDS_QUEUE_URL: u })!;
    await c.send({} as never);
    expect(sqsCtor).toHaveBeenCalledWith({ region, credentials: expect.any(Function) });
  });
});
