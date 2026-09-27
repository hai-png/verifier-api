/**
 * apiKeyLookup.ts
 *
 * Resolve an API key and its workspace in ONE database round trip.
 *
 * `prisma.apiKey.findFirst({ include: { workspace: true } })` runs as two
 * sequential queries (key, then workspace). With the API in Oregon and the
 * database in Frankfurt, each is ~150 ms, so every authenticated request paid
 * ~300 ms before any work started. Live test run 36288047216 showed it: a
 * valid-key request that fails validation was ~170 ms slower than an
 * unknown-key request, while server-side pipeline time was 0.2 ms.
 *
 * The column lists come from the Prisma DMMF, so they follow schema changes
 * (including @map/@@map). Values are coerced to the same JS types Prisma returns.
 * If the raw query ever fails (driver/dialect drift), we log once and fall back
 * to the original two-query Prisma call for the life of the process.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import logger from './logger';

type ScalarField = { name: string; dbName: string; type: string };
type ModelInfo = { table: string; fields: ScalarField[] };

function modelInfo(name: string): ModelInfo {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
  if (!model) throw new Error(`Prisma model ${name} not found in DMMF`);
  return {
    table: model.dbName ?? model.name,
    fields: model.fields
      .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
      .map((f) => ({ name: f.name, dbName: f.dbName ?? f.name, type: f.kind === 'enum' ? 'Enum' : f.type })),
  };
}

const ident = (value: string): string => `\`${value.replace(/`/g, '``')}\``;

export function coerceScalar(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'Boolean':
      return typeof value === 'bigint' ? value !== 0n : Boolean(Number(value));
    case 'Int':
    case 'Float':
      return typeof value === 'bigint' ? Number(value) : Number(value);
    case 'DateTime':
      return value instanceof Date ? value : new Date(value as string);
    case 'Json':
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return value; }
      }
      return value;
    default:
      return value;
  }
}

let cachedSql: { apiKey: ModelInfo; workspace: ModelInfo; select: string } | null = null;
function lookupSql() {
  if (cachedSql) return cachedSql;
  const apiKey = modelInfo('ApiKey');
  const workspace = modelInfo('Workspace');
  const select = [
    ...apiKey.fields.map((f) => `k.${ident(f.dbName)} AS ${ident(`k__${f.name}`)}`),
    ...workspace.fields.map((f) => `w.${ident(f.dbName)} AS ${ident(`w__${f.name}`)}`),
  ].join(', ');
  cachedSql = { apiKey, workspace, select };
  return cachedSql;
}

function mapRow(row: Record<string, unknown>) {
  const { apiKey, workspace } = lookupSql();
  const key: Record<string, unknown> = {};
  for (const f of apiKey.fields) key[f.name] = coerceScalar(f.type, row[`k__${f.name}`]);
  const ws: Record<string, unknown> = {};
  for (const f of workspace.fields) ws[f.name] = coerceScalar(f.type, row[`w__${f.name}`]);
  key.workspace = ws;
  return key;
}

let rawDisabled = process.env.API_KEY_SINGLE_QUERY === 'false';

type KeyWithWorkspace = Prisma.ApiKeyGetPayload<{ include: { workspace: true } }>;

export async function findActiveApiKeyWithWorkspace(
  db: PrismaClient,
  keyHash: string,
  legacyKey: string,
): Promise<KeyWithWorkspace | null> {
  if (!rawDisabled) {
    try {
      const { apiKey, workspace, select } = lookupSql();
      const keyTable = Prisma.raw(ident(apiKey.table));
      const wsTable = Prisma.raw(ident(workspace.table));
      const col = (m: ModelInfo, name: string) => Prisma.raw(ident(m.fields.find((f) => f.name === name)!.dbName));
      const rows = await db.$queryRaw<Record<string, unknown>[]>`
        SELECT ${Prisma.raw(select)}
        FROM ${keyTable} k
        JOIN ${wsTable} w ON w.${col(workspace, 'id')} = k.${col(apiKey, 'workspaceId')}
        WHERE k.${col(apiKey, 'isActive')} = true
          AND (k.${col(apiKey, 'keyHash')} = ${keyHash} OR k.${col(apiKey, 'key')} = ${legacyKey})
        LIMIT 1`;
      return rows.length ? (mapRow(rows[0]) as unknown as KeyWithWorkspace) : null;
    } catch (error) {
      rawDisabled = true;
      logger.error('Single-query API key lookup failed; falling back to Prisma include for this process.', {
        error: (error as Error)?.message,
      });
    }
  }
  return db.apiKey.findFirst({
    where: { isActive: true, OR: [{ keyHash }, { key: legacyKey }] },
    include: { workspace: true },
  });
}
