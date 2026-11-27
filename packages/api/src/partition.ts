/** AWS partition of the central account and of every customer account (a role cannot be assumed across partitions). D-58. */
export const PARTITIONS = ['aws', 'aws-cn', 'aws-us-gov'] as const;
export type Partition = (typeof PARTITIONS)[number];
export const DEFAULT_PARTITION: Partition = 'aws';

export const isPartition = (v: unknown): v is Partition => typeof v === 'string' && (PARTITIONS as readonly string[]).includes(v);

/** `AWS_PARTITION` unset or blank -> `aws`. A value outside the three partitions throws at start-up (a typo must not silently build `aws` ARNs). */
export function partitionFromEnv(env: Record<string, string | undefined>): Partition {
  const v = env.AWS_PARTITION?.trim();
  if (!v) return DEFAULT_PARTITION;
  if (!isPartition(v)) throw new Error('AWS_PARTITION must be one of aws, aws-cn, aws-us-gov');
  return v;
}
