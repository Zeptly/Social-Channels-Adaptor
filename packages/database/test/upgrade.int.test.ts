/**
 * Upgrade path of the gateway refactor migration (0001): a database created by
 * the pre-refactor release, holding live data, migrates in place with every
 * row, id and ownership mapping intact.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder, runMigrations } from "../src/migrator.js";

const base = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/zeptly_social_test";
const DB = "outstand_gateway_upgrade_test";
const url = (() => {
  const u = new URL(base);
  u.pathname = `/${DB}`;
  return u.toString();
})();

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A copy of migrations/ whose journal stops at 0000 (the pre-refactor release). */
function preRefactorFolder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gw-mig-"));
  cpSync(defaultMigrationsFolder(), dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag === "0000_init");
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("0001_gateway_connections upgrade", () => {
  afterAll(async () => {
    await admin((c) => c.query(`drop database if exists ${DB} with (force)`));
  });

  it("renames social_connections in place, keeping data, FKs and a compatible view", async () => {
    await admin(async (c) => {
      await c.query(`drop database if exists ${DB} with (force)`);
      await c.query(`create database ${DB}`);
    });
    await runMigrations({ url, migrationsFolder: preRefactorFolder(), log: () => {} });

    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      const ws = (await db.query("insert into workspaces (external_id, provider_tenant_ref) values ('ws_up', 'zs_up') returning id")).rows[0].id;
      const conn = (
        await db.query("insert into social_connections (workspace_id, network, provider, status) values ($1, 'linkedin', 'outstand', 'connected') returning id", [ws])
      ).rows[0].id;
      await db.query("insert into provider_accounts (workspace_id, connection_id, provider, external_id, network) values ($1, $2, 'outstand', 'acct_1', 'linkedin')", [ws, conn]);

      await runMigrations({ url, log: () => {} });

      expect((await db.query("select id, workspace_id, status from gateway_connections")).rows).toEqual([{ id: conn, workspace_id: ws, status: "connected" }]);
      expect((await db.query("select connection_id from provider_accounts where external_id = 'acct_1'")).rows).toEqual([{ connection_id: conn }]);
      // Ownership FK still enforced against the renamed table.
      await expect(
        db.query("insert into provider_accounts (workspace_id, connection_id, provider, external_id, network) values ($1, gen_random_uuid(), 'outstand', 'acct_x', 'linkedin')", [ws]),
      ).rejects.toMatchObject({ code: "23503" });
      const fks = (await db.query("select conname from pg_constraint where confrelid = 'gateway_connections'::regclass order by conname")).rows.map((r) => r.conname);
      expect(fks).toEqual([
        "provider_accounts_connection_id_gateway_connections_id_fk",
        "social_conversations_connection_id_gateway_connections_id_fk",
        "social_metrics_connection_id_gateway_connections_id_fk",
        "social_post_targets_connection_id_gateway_connections_id_fk",
      ]);
      // Previous-release code path: the old name still reads and writes.
      expect((await db.query("select count(*)::int as n from social_connections")).rows[0].n).toBe(1);
      await db.query("update social_connections set status = 'degraded' where id = $1", [conn]);
      expect((await db.query("select status from gateway_connections where id = $1", [conn])).rows[0].status).toBe("degraded");
      // Re-running is a no-op.
      await runMigrations({ url, log: () => {} });
    } finally {
      await db.end();
    }
  });
});
