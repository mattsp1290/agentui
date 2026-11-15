export const OBSERVABILITY_BOUNDS = {
  requestDeadlineMs: 500,
  acknowledgementBytes: 64 * 1024,
  batchTimeoutMs: 750,
  shutdownDeadlineMs: 1000,
  flushIntervalMs: 1000,
  maxQueueSize: 128,
  maxBatchSize: 32,
  maxActiveSpans: 128,
} as const;
