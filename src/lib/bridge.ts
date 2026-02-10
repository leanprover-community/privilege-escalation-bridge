import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
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
