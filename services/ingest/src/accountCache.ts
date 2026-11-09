/**
 * Account → customer cache, 5 min TTL; on lookup failure keep the previous mapping (known-bugs 1-8, Q2).
 * Clock is injected for tests.
 */
export class AccountCustomerCache {
  private entries = new Map<string, { customerId: string | null; at: number }>();
  constructor(
    private readonly lookup: (awsAccountId: string) => Promise<string | null>,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(awsAccountId: string): Promise<string | null> {
    const e = this.entries.get(awsAccountId);
    if (e && this.now() - e.at < this.ttlMs) return e.customerId;
    try {
      const customerId = await this.lookup(awsAccountId);
      this.entries.set(awsAccountId, { customerId, at: this.now() });
      return customerId;
    } catch (err) {
      if (e) return e.customerId;
      throw err;
    }
  }
}
