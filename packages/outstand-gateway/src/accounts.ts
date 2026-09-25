import type { PendingProviderConnection, ProviderAccountPort, ProviderAccountRecord } from "@zeptly-gateway/gateway-core";
import type { OutstandAccount, OutstandClient } from "@zeptly-gateway/outstand-client";

/** Provider-account lifecycle on Outstand (Managed-Key networks; Outstand "network" = gateway channel). */
export class OutstandAccountPort implements ProviderAccountPort {
  constructor(private readonly client: OutstandClient) {}

  initiateConnection(input: { channel: string; redirectUri: string; tenantRef: string }): Promise<{ authorizationUrl: string }> {
    return this.client.initiateConnection({ network: input.channel, redirectUri: input.redirectUri, tenantRef: input.tenantRef });
  }

  async connectWithCredentials(input: { channel: string; tenantRef: string; credentials: { handle: string; appPassword: string } }): Promise<ProviderAccountRecord[]> {
    return (await this.client.connectWithCredentials({ network: input.channel, tenantRef: input.tenantRef, credentials: input.credentials })).map(toRecord);
  }

  async getPendingConnection(sessionToken: string): Promise<PendingProviderConnection> {
    const p = await this.client.getPendingConnection(sessionToken);
    return {
      channel: p.network,
      ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
      options: p.options.map((o) => ({
        id: o.id,
        name: o.name,
        ...(o.username ? { username: o.username } : {}),
        ...(o.type ? { type: o.type } : {}),
        ...(o.avatarUrl ? { avatarUrl: o.avatarUrl } : {}),
      })),
    };
  }

  async finalizeConnection(sessionToken: string, optionIds: string[]): Promise<ProviderAccountRecord[]> {
    return (await this.client.finalizeConnection(sessionToken, optionIds)).map(toRecord);
  }

  async listAccounts(filter: { tenantRef?: string } = {}): Promise<ProviderAccountRecord[]> {
    return (await this.client.listAccounts(filter)).map(toRecord);
  }

  disconnectAccount(externalId: string): Promise<void> {
    return this.client.disconnectAccount(externalId);
  }
}

function toRecord(a: OutstandAccount): ProviderAccountRecord {
  return {
    externalId: a.externalId,
    channel: a.network,
    ...(a.username ? { username: a.username } : {}),
    ...(a.displayName ? { displayName: a.displayName } : {}),
    ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    ...(a.accountType ? { accountType: a.accountType } : {}),
    isActive: a.isActive,
    ...(a.tenantRef ? { tenantRef: a.tenantRef } : {}),
  };
}
