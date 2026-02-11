import { cp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  OUTPUT_KEY_RE,
  SCHEMA_VERSION,
  ensureDir,
  normalizeOutputs,
  parseJsonObject,
  validateMeta,
  type BridgeMeta,
  type OutputsMap
} from './schema.js';

export interface ProducerContext {
  repository: string;
  workflowName: string;
  runId: string;
  runAttempt: string;
  eventName: string;
  headSha: string;
  prNumber?: number;
  producerJob?: string;
}

export interface ConsumerExpectations {
  repository: string;
  runId: string;
  runAttempt?: string;
  sourceWorkflow?: string;
  expectedHeadSha?: string;
  expectedPrNumber?: string;
  requireEvents?: string[];
}

export interface ExtractMapping {
  name: string;
  path: string;
}

export function buildBridgeMeta(
  producer: ProducerContext,
  extraMeta: Record<string, unknown>
): BridgeMeta {
  return {
    schema_version: SCHEMA_VERSION,
    repository: producer.repository,
    workflow_name: producer.workflowName,
    workflow_run_id: producer.runId,
    workflow_run_attempt: producer.runAttempt,
    event_name: producer.eventName,
    head_sha: producer.headSha,
    created_at: new Date().toISOString(),
    ...(typeof producer.prNumber === 'number' ? { pr_number: producer.prNumber } : {}),
    ...(producer.producerJob ? { producer_job: producer.producerJob } : {}),
    ...extraMeta
  };
}

export function parseAndMergeOutputs(
  outputJson: string,
  outputFileJson: string,
  sanitize: 'strict' | 'none'
): OutputsMap {
  const fromFile = outputFileJson ? parseJsonObject(outputFileJson, 'outputs_file') : {};
  const fromInput = outputJson ? parseJsonObject(outputJson, 'outputs') : {};
  return normalizeOutputs({ ...fromFile, ...fromInput }, sanitize);
}

export async function writeBridgeDirectory(
  rootDir: string,
  outputs: OutputsMap,
  meta: BridgeMeta,
  files: string[]
): Promise<void> {
  const bridgeDir = path.join(rootDir, 'bridge');
  const filesDir = path.join(bridgeDir, 'files');

  await ensureDir(filesDir);
  await writeFile(path.join(bridgeDir, 'outputs.json'), JSON.stringify(outputs, null, 2));
  await writeFile(path.join(bridgeDir, 'meta.json'), JSON.stringify(meta, null, 2));

  for (const filePath of files) {
    if (path.isAbsolute(filePath)) {
      throw new Error(`files entries must be relative paths: ${filePath}`);
    }
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..')) {
      throw new Error(`files entry may not escape workspace: ${filePath}`);
    }
    const absolute = path.resolve(filePath);
    const destination = path.join(filesDir, normalized);
    await ensureDir(path.dirname(destination));
    await cp(absolute, destination, { recursive: false });
  }
}

export async function readBridgeDirectory(rootDir: string): Promise<{
  outputs: OutputsMap;
  meta: BridgeMeta;
  filesDir: string;
}> {
  const bridgeDir = path.join(rootDir, 'bridge');
  const meta = parseJsonObject(await readFile(path.join(bridgeDir, 'meta.json'), 'utf8'), 'meta.json');
  validateMeta(meta);

  const outputs = normalizeOutputs(
    parseJsonObject(await readFile(path.join(bridgeDir, 'outputs.json'), 'utf8'), 'outputs.json'),
    'strict'
  );

  return {
    outputs,
    meta,
    filesDir: path.join(bridgeDir, 'files')
  };
}

export async function restoreBridgeFiles(filesDir: string, destination: string): Promise<boolean> {
  try {
    const sourceStat = await stat(filesDir);
    if (!sourceStat.isDirectory()) {
      return false;
    }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  await ensureDir(destination);
  await cp(filesDir, destination, { recursive: true, force: true });
  return true;
}

export function validateConsumerExpectations(
  meta: BridgeMeta,
  expectations: ConsumerExpectations
): void {
  if (meta.repository !== expectations.repository) {
    throw new Error(`Repository mismatch: expected ${expectations.repository}, got ${meta.repository}`);
  }
  if (meta.workflow_run_id !== expectations.runId) {
    throw new Error(`Run mismatch: expected ${expectations.runId}, got ${meta.workflow_run_id}`);
  }
  if (expectations.runAttempt && meta.workflow_run_attempt !== expectations.runAttempt) {
    throw new Error(
      `Run attempt mismatch: expected ${expectations.runAttempt}, got ${meta.workflow_run_attempt}`
    );
  }
  if (expectations.sourceWorkflow && meta.workflow_name !== expectations.sourceWorkflow) {
    throw new Error(
      `Workflow mismatch: expected ${expectations.sourceWorkflow}, got ${meta.workflow_name}`
    );
  }
  if (expectations.expectedHeadSha && meta.head_sha !== expectations.expectedHeadSha) {
    throw new Error(
      `Head SHA mismatch: expected ${expectations.expectedHeadSha}, got ${meta.head_sha}`
    );
  }
  if (expectations.expectedPrNumber && String(meta.pr_number) !== expectations.expectedPrNumber) {
    throw new Error(
      `PR mismatch: expected ${expectations.expectedPrNumber}, got ${String(meta.pr_number)}`
    );
  }
  if (
    expectations.requireEvents &&
    expectations.requireEvents.length > 0 &&
    !expectations.requireEvents.includes(meta.event_name)
  ) {
    throw new Error(`Source event ${meta.event_name} is not allowed`);
  }
}

export function parseExtractMappings(raw: string): ExtractMapping[] {
  if (!raw.trim()) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const idx = line.indexOf('=');
    if (idx <= 0 || idx === line.length - 1) {
      throw new Error(`Invalid extract mapping '${line}'. Use 'output_name=source.path'`);
    }
    const name = line.slice(0, idx).trim();
    const sourcePath = line.slice(idx + 1).trim();
    if (!OUTPUT_KEY_RE.test(name)) {
      throw new Error(`Invalid extract output key: ${name}`);
    }
    if (!sourcePath) {
      throw new Error(`Invalid extract mapping '${line}': missing source path`);
    }
    return { name, path: sourcePath };
  });
}

export function parsePathList(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getByPath(
  value: unknown,
  pathSpec: string
): string | number | boolean | null | undefined {
  if (pathSpec.includes('|')) {
    const candidates = pathSpec
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const found = getByPath(value, candidate);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  const parts = pathSpec.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;

  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    const objectValue = current as Record<string, unknown>;
    if (!(part in objectValue)) return undefined;
    current = objectValue[part];
  }

  if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
    return current as string | number | boolean | null;
  }
  return undefined;
}

export function pickByPaths(value: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const setByPath = (target: Record<string, unknown>, pathSpec: string, scalar: string | number | boolean | null) => {
    const parts = pathSpec.split('.').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return;
    let cursor: Record<string, unknown> = target;
    for (let idx = 0; idx < parts.length - 1; idx += 1) {
      const part = parts[idx];
      const current = cursor[part];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        const next: Record<string, unknown> = {};
        cursor[part] = next;
        cursor = next;
      } else {
        cursor = current as Record<string, unknown>;
      }
    }
    cursor[parts[parts.length - 1]] = scalar;
  };

  for (const pathSpec of paths) {
    const v = getByPath(value, pathSpec);
    if (v !== undefined) {
      setByPath(out, pathSpec, v);
    }
  }
  return out;
}
