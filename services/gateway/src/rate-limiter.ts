export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

interface TokenBucket {
  count: number;
  resetAtMs: number;
}

export class TokenRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  public constructor(
    private readonly options: {
      windowMs: number;
      maxRequests: number;
    }
  ) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error("TokenRateLimiter windowMs must be a positive number");
    }
    if (!Number.isFinite(options.maxRequests) || options.maxRequests <= 0) {
      throw new Error("TokenRateLimiter maxRequests must be a positive number");
    }
  }

  public consume(token: string, nowMs = Date.now()): RateLimitDecision {
    this.pruneExpired(nowMs);

    const existing = this.buckets.get(token);
    if (!existing || existing.resetAtMs <= nowMs) {
      const resetAtMs = nowMs + this.options.windowMs;
      this.buckets.set(token, {
        count: 1,
        resetAtMs
      });
      return {
        allowed: true,
        remaining: Math.max(this.options.maxRequests - 1, 0),
        resetInMs: this.options.windowMs
      };
    }

    existing.count += 1;
    const remaining = Math.max(this.options.maxRequests - existing.count, 0);
    const resetInMs = Math.max(existing.resetAtMs - nowMs, 0);

    if (existing.count > this.options.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetInMs
      };
    }

    return {
      allowed: true,
      remaining,
      resetInMs
    };
  }

  private pruneExpired(nowMs: number): void {
    for (const [token, bucket] of this.buckets.entries()) {
      if (bucket.resetAtMs <= nowMs) {
        this.buckets.delete(token);
      }
    }
  }
}
