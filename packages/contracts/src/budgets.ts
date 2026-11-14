import { JSON_MAX_DEPTH, JSON_MAX_NODES } from './durable.js';

export const CORE_CATALOG_PAGE = 100;
export const HOST_DEFAULT_PAGE_EVENTS = 64;
export const HOST_DEFAULT_PAGE_BYTES = 256_000;
export const HOST_DEFAULT_SNAPSHOT_BYTES = 4_000_000;

export const CORE_SNAPSHOT_ENVELOPE_RESERVE = { nodes: 64, depth: 8 } as const;
export const CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET = {
  maxNodes: JSON_MAX_NODES - CORE_SNAPSHOT_ENVELOPE_RESERVE.nodes,
  maxDepth: JSON_MAX_DEPTH - CORE_SNAPSHOT_ENVELOPE_RESERVE.depth,
} as const;
