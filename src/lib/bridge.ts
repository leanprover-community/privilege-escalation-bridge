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

/**
 * GitHub's own record of the producer run (from the `workflow_run` event payload or the REST API).
 * Unlike `meta.json`, the producer cannot forge these fields.
 */
export interface UpstreamRun {
  id: string;
  /** Only set when taken from the triggering event payload; the REST API reports the latest attempt. */
  runAttempt?: string;
  event: string;
  workflowName: string;
  /** The user whose event triggered the run (`workflow_run.actor`); unchanged by re-runs. */
  actor?: string;
  /** For review events, the PR head when GitHub created the run, which can postdate the review. */
  headSha?: string;
  headBranch?: string;
  createdAt?: string;
}

export type ProducerTrust = 'trusted-workflow' | 'untrusted';

export interface UpstreamExpectations {
  sourceWorkflow?: string;
  requireEvents?: string[];
  /** Events whose untrusted runs may still expose raw artifact values. */
  untrustedProducerEvents?: string[];
  verify?: boolean;
}

export interface ProducerAccess {
  trust: ProducerTrust;
  /** Whether raw artifact values (per-key outputs, outputs / meta / event, files) may be exposed. */
  raw: boolean;
}

export const PRODUCER_EVENTS_DOCS =
  'https://github.com/leanprover-community/privilege-escalation-bridge#producer-events';

const RAW_EXTRACT_ROOTS = ['outputs', 'meta', 'event'];
const EXTRACT_ROOTS = [...RAW_EXTRACT_ROOTS, 'run', 'verified'];

// What a consumer must keep in mind for each untrusted event, shown when it is rejected.
const UNTRUSTED_EVENT_RISKS: Record<string, string> = {
  pull_request:
    "GitHub runs this event's workflow file from the pull request, so for a fork PR every artifact " +
    'value, including meta.pr_number, may be forged',
  pull_request_review:
    "GitHub runs this event's workflow file from the pull request, which may come from a fork. The " +
    'reviewer (run.actor) is genuine, but the review body, event fields and PR number in the artifact may be forged',
  pull_request_review_comment:
    "GitHub runs this event's workflow file from the pull request, which may come from a fork. The " +
    'commenter (run.actor) is genuine, but the comment body, event fields and PR number in the artifact may be forged'
};

export interface ConsumerExpectations {
  repository: string;
  runId?: string;
  runAttempt?: string;
  sourceWorkflow?: string;
  expectedHeadSha?: string;
  expectedPrNumber?: string;
  requireEvents?: string[];
  upstream?: UpstreamRun;
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

/**
 * Classifies who controls the producer's workflow file, from the event in GitHub's record of the run.
 *
 * For `pull_request*` events other than `pull_request_target`, GitHub runs the workflow file from the
 * pull request's merge ref, so when the PR comes from a fork its author controls the whole producer
 * job and can write any artifact they like. This depends on the event alone, not on whether a given
 * PR is a fork, so a consumer behaves the same for every run of an event (and GitHub's
 * head_repository is wrong for review events anyway). `trusted-workflow` means only the workflow
 * file is trusted: artifact contents may still carry PR-derived data.
 */
export function classifyProducerTrust(event: string): ProducerTrust {
  return event.startsWith('pull_request') && event !== 'pull_request_target' ? 'untrusted' : 'trusted-workflow';
}

export function parseUntrustedProducerEvents(raw: string, requireEvents: string[]): string[] {
  const events = parsePathList(raw);
  for (const event of events) {
    if (event === 'true' || event === 'false') {
      throw new Error(
        'untrusted_producer_events takes event names, not a boolean: list the events whose untrusted runs ' +
          `may expose raw artifact values, for example pull_request. See ${PRODUCER_EVENTS_DOCS}`
      );
    }
    if (classifyProducerTrust(event) !== 'untrusted') {
      throw new Error(`untrusted_producer_events: ${event} producer runs are never untrusted, so listing it has no effect`);
    }
    if (requireEvents.length > 0 && !requireEvents.includes(event)) {
      throw new Error(`untrusted_producer_events: ${event} is not allowed by require_event`);
    }
  }
  return events;
}

/**
 * Checks that need only GitHub's record of the producer run, so they can run before download.
 * Returns whether raw artifact values may be exposed: an untrusted run needs its event listed in
 * untrusted_producer_events for that, and otherwise is accepted only with verify, exposing run.* and
 * verified.* values alone.
 */
export function validateUpstreamRun(run: UpstreamRun, expectations: UpstreamExpectations): ProducerAccess {
  if (expectations.sourceWorkflow && run.workflowName !== expectations.sourceWorkflow) {
    throw new Error(
      `Workflow mismatch: expected ${expectations.sourceWorkflow}, producer run belongs to ${run.workflowName}`
    );
  }
  if (
    expectations.requireEvents &&
    expectations.requireEvents.length > 0 &&
    !expectations.requireEvents.includes(run.event)
  ) {
    throw new Error(`Source event ${run.event} is not allowed`);
  }
  const trust = classifyProducerTrust(run.event);
  if (trust === 'trusted-workflow' || expectations.untrustedProducerEvents?.includes(run.event)) {
    return { trust, raw: true };
  }
  if (expectations.verify) {
    return { trust, raw: false };
  }
  const risk =
    UNTRUSTED_EVENT_RISKS[run.event] ??
    "GitHub runs this event's workflow file from the pull request, so for a fork PR every artifact value may be forged";
  throw new Error(
    `Producer run ${run.id} (${run.event}) is untrusted. ${risk}. Set verify: true and read run.* and ` +
      `verified.* values, or add ${run.event} to untrusted_producer_events if every bridge value is ` +
      `treated as untrusted. See ${PRODUCER_EVENTS_DOCS}`
  );
}

/**
 * Checks the roots of extract mappings: every root must exist, verified.* needs verify, and when raw
 * values are withheld (an untrusted producer accepted through verify), outputs.*, meta.* and event.*
 * are refused rather than silently resolved.
 */
export function validateExtractRoots(
  mappings: ExtractMapping[],
  access: { raw: boolean; verify: boolean }
): void {
  for (const mapping of mappings) {
    const roots = mapping.path
      .split('|')
      .map((candidate) => candidate.split('.')[0].trim())
      .filter(Boolean);
    for (const root of roots) {
      if (!EXTRACT_ROOTS.includes(root)) {
        throw new Error(`Extract mapping '${mapping.name}' uses unknown root '${root}'; use ${EXTRACT_ROOTS.join(', ')}`);
      }
      if (root === 'verified' && !access.verify) {
        throw new Error(`Extract mapping '${mapping.name}' reads verified.*, which requires verify: true`);
      }
      if (!access.raw && RAW_EXTRACT_ROOTS.includes(root)) {
        throw new Error(
          `Extract mapping '${mapping.name}' reads ${root}.*, but this untrusted producer run exposes only ` +
            'run.* and verified.* values. Read those instead, or list the event in untrusted_producer_events.'
        );
      }
    }
  }
}

/** The run.* extract root: GitHub's record of the producer run. */
export function runRecord(run: UpstreamRun): Record<string, string> {
  const record: Record<string, string> = { id: run.id, event: run.event, workflow: run.workflowName };
  if (run.runAttempt) record.attempt = run.runAttempt;
  if (run.actor) record.actor = run.actor;
  if (run.headSha) record.head_sha = run.headSha;
  if (run.headBranch) record.head_branch = run.headBranch;
  if (run.createdAt) record.created_at = run.createdAt;
  return record;
}

export function validateConsumerExpectations(
  meta: BridgeMeta,
  expectations: ConsumerExpectations
): void {
  if (meta.repository !== expectations.repository) {
    throw new Error(`Repository mismatch: expected ${expectations.repository}, got ${meta.repository}`);
  }
  if (expectations.runId && meta.workflow_run_id !== expectations.runId) {
    throw new Error(`Run mismatch: expected ${expectations.runId}, got ${meta.workflow_run_id}`);
  }
  if (expectations.runId && expectations.runAttempt && meta.workflow_run_attempt !== expectations.runAttempt) {
    throw new Error(
      `Run attempt mismatch: expected ${expectations.runAttempt}, got ${meta.workflow_run_attempt}`
    );
  }
  // Bind the self-reported event and workflow name to GitHub's record, so the source_workflow and
  // require_event checks below (and any consumer reading meta.event_name / meta.workflow_name)
  // see values the producer cannot forge. head_sha is not bound: emit records GITHUB_SHA, which is
  // the PR merge commit for pull_request* events, while GitHub records the PR head commit.
  if (expectations.upstream) {
    if (meta.event_name !== expectations.upstream.event) {
      throw new Error(
        `Event mismatch: producer run was triggered by ${expectations.upstream.event}, artifact claims ${meta.event_name}`
      );
    }
    if (meta.workflow_name !== expectations.upstream.workflowName) {
      throw new Error(
        `Workflow mismatch: producer run belongs to ${expectations.upstream.workflowName}, artifact claims ${meta.workflow_name}`
      );
    }
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
