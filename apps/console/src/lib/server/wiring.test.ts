import { describe, expect, it } from "vitest";
import { resolvePartition } from "./wiring";

const q = (host: string) => `https://${host}/123456789012/alarm-commands`;
const SEOUL = q("sqs.ap-northeast-2.amazonaws.com");
const VIRGINIA = q("sqs.us-east-1.amazonaws.com");
const CHINA = q("sqs.cn-north-1.amazonaws.com.cn");
const GOV = q("sqs.us-gov-west-1.amazonaws.com");

describe("resolvePartition (D-58, security recommendation 1 on #97)", () => {
  it("defaults to aws with neither value", () => {
    expect(resolvePartition({})).toBe("aws");
    expect(resolvePartition({ AWS_PARTITION: "  ", ALARM_COMMANDS_QUEUE_URL: " " })).toBe("aws");
  });
  it("Seoul / aws is unchanged, with or without AWS_PARTITION", () => {
    expect(resolvePartition({ ALARM_COMMANDS_QUEUE_URL: SEOUL })).toBe("aws");
    expect(resolvePartition({ ALARM_COMMANDS_QUEUE_URL: SEOUL, AWS_PARTITION: "aws" })).toBe("aws");
    expect(resolvePartition({ ALARM_COMMANDS_QUEUE_URL: VIRGINIA })).toBe("aws");
  });
  it("derives the partition from the queue URL when AWS_PARTITION is unset", () => {
    expect(resolvePartition({ ALARM_COMMANDS_QUEUE_URL: CHINA })).toBe("aws-cn");
    expect(resolvePartition({ ALARM_COMMANDS_QUEUE_URL: GOV })).toBe("aws-us-gov");
  });
  it("uses AWS_PARTITION alone when there is no queue URL", () => {
    expect(resolvePartition({ AWS_PARTITION: "aws-cn" })).toBe("aws-cn");
  });
  it("throws at start-up when the two disagree", () => {
    expect(() => resolvePartition({ ALARM_COMMANDS_QUEUE_URL: CHINA, AWS_PARTITION: "aws" })).toThrow(/does not match/);
    expect(() => resolvePartition({ ALARM_COMMANDS_QUEUE_URL: GOV, AWS_PARTITION: "aws" })).toThrow(/does not match/);
    expect(() => resolvePartition({ ALARM_COMMANDS_QUEUE_URL: SEOUL, AWS_PARTITION: "aws-us-gov" })).toThrow(/does not match/);
  });
  it("throws on a value outside the three partitions", () => {
    expect(() => resolvePartition({ AWS_PARTITION: "aws-iso" })).toThrow();
  });
  it("throws on a malformed queue URL", () => {
    expect(() => resolvePartition({ ALARM_COMMANDS_QUEUE_URL: "https://example.com/x" })).toThrow();
  });
});
