import type { Price } from './registry.js';

export interface Usage {
  /** Total prompt tokens, including cached ones. */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in USD. Cache reads and writes are billed at their own rates, the remainder of the prompt at the input rate. */
export function computeCost(price: Price, u: Usage): number {
  const fresh = Math.max(0, u.promptTokens - u.cacheReadTokens - u.cacheWriteTokens);
  return (
    (fresh * price.input +
      u.cacheReadTokens * (price.cacheRead ?? price.input) +
      u.cacheWriteTokens * (price.cacheWrite ?? price.input) +
      u.completionTokens * price.output) /
    1_000_000
  );
}
