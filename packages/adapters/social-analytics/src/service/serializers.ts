import type { SocialMetricRow, Workspace } from "@zeptly-gateway/database";
import { opt } from "@zeptly-gateway/gateway-core";
import type { SocialNetwork } from "@zeptly-gateway/social-publishing/contract";
import type { SocialMetric } from "../contract.js";

export function toMetric(row: SocialMetricRow, ws: Workspace): SocialMetric {
  return {
    workspaceId: ws.externalId,
    ...opt("connectionId", row.connectionId),
    ...opt("postId", row.postId),
    ...opt("targetId", row.targetId),
    network: row.network as SocialNetwork,
    metric: row.metric,
    value: row.value,
    measuredAt: row.measuredAt.toISOString(),
    provider: row.provider,
    semantics: `${row.network}.${row.metric}`,
  };
}
