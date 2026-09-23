import type { PostStatus, TargetStatus } from "./models.js";

const TERMINAL_TARGET: ReadonlySet<TargetStatus> = new Set(["published", "failed", "cancelled"]);

export function isTerminalTargetStatus(status: TargetStatus): boolean {
  return TERMINAL_TARGET.has(status);
}

/**
 * Derive the canonical post status from its target statuses.
 *
 * The important property: a post is only `published` when EVERY target
 * published. Any mix of published and failed/cancelled targets is
 * `partially_published` — never reported as complete success.
 */
export function aggregatePostStatus(targets: readonly TargetStatus[], current: PostStatus): PostStatus {
  if (current === "cancelled" || current === "draft") return current;
  if (targets.length === 0) return current;

  const count = (s: TargetStatus) => targets.filter((t) => t === s).length;
  const published = count("published");
  const failed = count("failed");
  const cancelled = count("cancelled");
  const allTerminal = targets.every((t) => TERMINAL_TARGET.has(t));

  if (allTerminal) {
    if (published === targets.length) return "published";
    if (published > 0) return "partially_published";
    if (cancelled === targets.length) return "cancelled";
    if (failed > 0) return "failed";
    return "cancelled";
  }
  if (count("publishing") > 0 || published > 0 || failed > 0) return "publishing";
  if (count("scheduled") > 0) return "scheduled";
  return current === "scheduled" ? "scheduled" : "queued";
}
