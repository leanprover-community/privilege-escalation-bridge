import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 2;
export const OUTPUT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Scalar = string | number | boolean | null;
export type OutputsMap = Record<string, Scalar>;

export interface BridgeMeta {
  schema_version: number;
  repository: string;
  workflow_name: string;
  workflow_run_id: string;
  workflow_run_attempt: string;
  event_name: string;
  head_sha: string;
  created_at: string;
  pr_number?: number;
  producer_job?: string;
  producer_step?: string;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function normalizeOutputs(
  input: Record<string, unknown>,
  sanitize: 'strict' | 'none'
): OutputsMap {
  const out: OutputsMap = {};
  for (const [key, value] of Object.entries(input)) {
    if (sanitize === 'strict') {
      if (!OUTPUT_KEY_RE.test(key)) {
        throw new Error(`Invalid output key: ${key}`);
      }
      if (!isScalar(value)) {
        throw new Error(`Output ${key} must be a scalar value`);
      }
    }
    out[key] = value as Scalar;
  }
  return out;
}

export function validateMeta(meta: Record<string, unknown>): asserts meta is BridgeMeta {
  const required = [
    'schema_version',
    'repository',
    'workflow_name',
    'workflow_run_id',
    'workflow_run_attempt',
    'event_name',
    'head_sha',
    'created_at'
  ] as const;

  for (const key of required) {
    if (!(key in meta)) {
      throw new Error(`Missing required meta field: ${key}`);
    }
  }

  if (meta.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema_version: ${String(meta.schema_version)}`);
  }

  const stringFields = [
    'repository',
    'workflow_name',
    'workflow_run_id',
    'workflow_run_attempt',
    'event_name',
    'head_sha',
    'created_at'
  ];

  for (const field of stringFields) {
    if (typeof meta[field] !== 'string' || !meta[field]) {
      throw new Error(`Invalid meta field: ${field}`);
    }
  }

  if (meta.pr_number !== undefined && typeof meta.pr_number !== 'number') {
    throw new Error('meta.pr_number must be a number when provided');
  }

  if (meta.event !== undefined) {
    if (!meta.event || typeof meta.event !== 'object' || Array.isArray(meta.event)) {
      throw new Error('meta.event must be an object when provided');
    }
  }
}

export function isScalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      files.push(...(await listFilesRecursively(full)));
    } else if (st.isFile()) {
      files.push(full);
    }
  }
  return files;
}
