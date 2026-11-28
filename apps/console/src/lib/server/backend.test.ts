import { beforeEach, describe, expect, it, vi } from "vitest";

const { pgClient } = vi.hoisted(() => ({ pgClient: vi.fn(() => ({ close: () => Promise.resolve() })) }));
vi.mock("server-only", () => ({}));
vi.mock("@alarmops/store-sql", () => ({ pgClient, SqlApiStore: class { constructor(public sql: unknown) {} } }));

import { backend } from "./backend";

const ENV = { DATABASE_URL: "postgres://u:p@localhost:5432/d", ALARM_COMMANDS_QUEUE_URL: "https://sqs.cn-north-1.amazonaws.com.cn/123456789012/q", AWS_PARTITION: "aws" };

describe("backend() start-up", () => {
  beforeEach(() => { pgClient.mockClear(); delete (globalThis as { __aoBackend?: unknown }).__aoBackend; });
  it("a partition mismatch throws before any pg pool is created (nothing leaks per request)", () => {
    expect(() => backend(ENV)).toThrow(/does not match/);
    expect(() => backend(ENV)).toThrow(/does not match/);
    expect(pgClient).not.toHaveBeenCalled();
  });
});
