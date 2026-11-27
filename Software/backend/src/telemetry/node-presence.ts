import { env } from "../config/env";

/**
 * `Node.online` is a last reported value, not proof of a live connection.
 * Derive the response value from last_seen so a crashed device becomes offline
 * without waiting for a background worker to mutate every row.
 */
export function isNodeOnline(
  node: { online: boolean; last_seen: Date | null },
  nowMs: number = Date.now(),
): boolean {
  if (!node.online || !node.last_seen) return false;
  return node.last_seen.getTime() >= nowMs - env.NODE_ONLINE_TTL_SEC * 1000;
}
