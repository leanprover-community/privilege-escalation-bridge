import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import AdmZip from 'adm-zip';

import {
  normalizeOutputs,
  parseJsonObject,
  validateMeta,
  type BridgeMeta,
  type OutputsMap
} from '../lib/schema.js';
import {
  classifyProducerTrust,
  getByPath,
  parseExtractMappings,
  parsePathList,
  parseUntrustedProducerEvents,
  readBridgeDirectory,
  restoreBridgeFiles,
  runRecord,
  validateConsumerExpectations,
  validateExtractRoots,
  validateUpstreamRun,
  type ExtractMapping,
  type UpstreamRun
} from '../lib/bridge.js';
import { createLogger, debugJson, type Logger } from '../lib/logging.js';
import { resolveAuthToken } from './token.js';
import { verifyProducerRun, type Verified } from './verify.js';

type Octokit = ReturnType<typeof getOctokit>;

interface LoadedBridge {
  meta: BridgeMeta;
  outputs: OutputsMap;
  filesDir?: string;
  tempDir?: string;
}

// The fields of a workflow run we read, common to the workflow_run payload and the REST API.
interface WorkflowRunRecord {
  id: number;
  run_attempt?: number;
  event: string;
  name?: string | null;
  actor?: { login: string } | null;
  head_sha?: string;
  head_branch?: string | null;
  created_at?: string;
}

function parseExposeMode(): 'outputs' | 'env' | 'both' {
  const expose = (core.getInput('expose') || 'outputs').trim();
  if (expose === 'outputs' || expose === 'env' || expose === 'both') {
    return expose;
  }
  throw new Error(`Invalid expose mode: ${expose}`);
}

function writeMaybeOutput(name: string, value: string, expose: 'outputs' | 'env' | 'both'): void {
  if (expose === 'outputs' || expose === 'both') {
    core.setOutput(name, value);
  }
  if (expose === 'env' || expose === 'both') {
    core.exportVariable(name, value);
  }
}

function toUpstreamRun(record: WorkflowRunRecord, fromPayload: boolean): UpstreamRun {
  if (typeof record.event !== 'string' || !record.event) {
    throw new Error(`GitHub's record of run ${record.id} has no event`);
  }
  if (typeof record.name !== 'string' || !record.name) {
    throw new Error(`GitHub's record of run ${record.id} has no workflow name`);
  }
  return {
    id: String(record.id),
    runAttempt: fromPayload && record.run_attempt ? String(record.run_attempt) : undefined,
    event: record.event,
    workflowName: record.name,
    actor: record.actor?.login,
    headSha: record.head_sha,
    headBranch: record.head_branch ?? undefined,
    createdAt: record.created_at
  };
}

// GitHub's record of the producer run: the triggering workflow_run payload when it describes runId,
// otherwise the REST API (when a token is available).
async function resolveUpstreamRun(
  octokit: Octokit | undefined,
  repository: string,
  runId: number | undefined
): Promise<UpstreamRun | undefined> {
  if (!runId) return undefined;
  const triggering = context.payload.workflow_run as WorkflowRunRecord | undefined;
  if (triggering && String(triggering.id) === String(runId)) {
    return toUpstreamRun(triggering, true);
  }
  if (!octokit) return undefined;
  const [owner, repo] = repository.split('/');
  const { data } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  return toUpstreamRun(data, false);
}

async function findBridgeArtifact(
  logger: Logger,
  octokit: Octokit,
  repository: string,
  runId: number,
  artifactName: string,
  failOnMissing: boolean
): Promise<{ id: number; name: string } | null> {
  const [owner, repo] = repository.split('/');
  const artifactsResp = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
    name: artifactName,
    per_page: 100
  });
  logger.info(
    `Found ${artifactsResp.data.artifacts.length} artifact(s) named '${artifactName}' on source run.`
  );
  debugJson(
    logger,
    'source artifacts',
    artifactsResp.data.artifacts.map((a) => ({ id: a.id, name: a.name, size_in_bytes: a.size_in_bytes }))
  );

  const artifactInfo = artifactsResp.data.artifacts.find((a) => a.name === artifactName);

  if (!artifactInfo) {
    if (failOnMissing) {
      throw new Error(`Artifact ${artifactName} was not found for run ${runId}`);
    }
    logger.warning(`Artifact '${artifactName}' not found; continuing because fail_on_missing=false.`);
    return null;
  }
  logger.info(`Selected artifact '${artifactInfo.name}' (id=${artifactInfo.id}).`);
  return { id: artifactInfo.id, name: artifactInfo.name };
}

async function downloadBridgeArtifact(
  logger: Logger,
  octokit: Octokit,
  repository: string,
  artifactId: number
): Promise<LoadedBridge> {
  const [owner, repo] = repository.split('/');
  const zipResp = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactId,
    archive_format: 'zip'
  });

  const zipBuffer = Buffer.from(zipResp.data as ArrayBuffer);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bridge-consume-'));
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(tempDir, true);
  const { meta, outputs, filesDir } = await readBridgeDirectory(tempDir);
  debugJson(logger, 'downloaded meta', meta);
  debugJson(logger, 'downloaded output keys', Object.keys(outputs));

  return {
    meta,
    outputs,
    filesDir,
    tempDir
  };
}

function validateExpectations(meta: BridgeMeta, runId: number | undefined, upstream: UpstreamRun | undefined): void {
  const expectedRepository = process.env.GITHUB_REPOSITORY || `${context.repo.owner}/${context.repo.repo}`;
  const sourceWorkflow = core.getInput('source_workflow');
  const expectedHeadSha = core.getInput('expected_head_sha');
  const expectedPrNumber = core.getInput('expected_pr_number');
  const requireEvent = parsePathList(core.getInput('require_event'));

  validateConsumerExpectations(meta, {
    repository: expectedRepository,
    runId: runId ? String(runId) : undefined,
    runAttempt: runId ? upstream?.runAttempt : undefined,
    sourceWorkflow: sourceWorkflow || undefined,
    expectedHeadSha: expectedHeadSha || undefined,
    expectedPrNumber: expectedPrNumber || undefined,
    requireEvents: requireEvent,
    upstream
  });
}

function loadOverrideBridge(logger: Logger, raw: string): LoadedBridge {
  const parsed = parseJsonObject(raw, 'override_json');
  const metaRaw = parsed.meta;
  const outputsRaw = parsed.outputs ?? {};

  if (!metaRaw || typeof metaRaw !== 'object' || Array.isArray(metaRaw)) {
    throw new Error('override_json.meta must be a JSON object');
  }
  if (!outputsRaw || typeof outputsRaw !== 'object' || Array.isArray(outputsRaw)) {
    throw new Error('override_json.outputs must be a JSON object');
  }

  const meta = metaRaw as Record<string, unknown>;
  validateMeta(meta);
  const outputs = normalizeOutputs(outputsRaw as Record<string, unknown>, 'strict');

  debugJson(logger, 'override meta', meta);
  debugJson(logger, 'override output keys', Object.keys(outputs));

  return {
    meta,
    outputs
  };
}

function emitExtractedValues(
  mappings: ExtractMapping[],
  roots: Record<string, unknown>,
  expose: 'outputs' | 'env' | 'both'
): string[] {
  const extractedKeys: string[] = [];

  for (const mapping of mappings) {
    const value = getByPath(roots, mapping.path);
    if (value === undefined) {
      throw new Error(`Missing extracted value for '${mapping.name}' at path '${mapping.path}'`);
    }
    const serialized = value === null ? 'null' : String(value);
    writeMaybeOutput(mapping.name, serialized, expose);
    extractedKeys.push(mapping.name);
  }

  return extractedKeys;
}

export async function run(): Promise<void> {
  const logger = createLogger();
  const overrideJson = core.getInput('override_json');
  const overrideEnabled = overrideJson.trim() !== '';
  const artifactName = core.getInput('artifact') || 'bridge';
  const runId = Number(core.getInput('run_id') || context.payload.workflow_run?.id);
  const failOnMissing = core.getBooleanInput('fail_on_missing', { required: false });
  const verify = core.getBooleanInput('verify', { required: false });
  const expose = parseExposeMode();
  const prefix = core.getInput('prefix') || '';
  const destination = path.resolve(core.getInput('path') || '.bridge');
  const repository = process.env.GITHUB_REPOSITORY || `${context.repo.owner}/${context.repo.repo}`;
  const sourceWorkflow = core.getInput('source_workflow') || undefined;
  const requireEvents = parsePathList(core.getInput('require_event'));
  const untrustedProducerEvents = parseUntrustedProducerEvents(
    core.getInput('untrusted_producer_events'),
    requireEvents
  );
  const mappings = parseExtractMappings(core.getInput('extract'));
  validateExtractRoots(mappings, { raw: true, verify });

  await logger.withGroup('Bridge Consume: Inputs', () => {
    logger.info(`Source mode: ${overrideEnabled ? 'override_json' : 'artifact'}`);
    logger.info(`Artifact name: ${artifactName}`);
    logger.info(`Source run id: ${String(runId || '(unset)')}`);
    logger.info(`Verify: ${String(verify)}`);
    logger.info(`Expose mode: ${expose}`);
    logger.info(`Output prefix: ${prefix || '(none)'}`);
    logger.info(`Restore path: ${destination}`);
    if (logger.debugEnabled) {
      logger.debug(`Repository: ${repository}`);
      logger.debug(`fail_on_missing: ${String(failOnMissing)}`);
      logger.debug(`source_workflow: ${sourceWorkflow || '(none)'}`);
      logger.debug(`expected_head_sha: ${core.getInput('expected_head_sha') || '(none)'}`);
      logger.debug(`expected_pr_number: ${core.getInput('expected_pr_number') || '(none)'}`);
      logger.debug(`require_event: ${requireEvents.join(',') || '(none)'}`);
      logger.debug(`untrusted_producer_events: ${untrustedProducerEvents.join(',') || '(none)'}`);
      logger.debug(`extract mappings provided: ${mappings.length > 0 ? 'yes' : 'no'}`);
      logger.debug(`override_json provided: ${overrideEnabled ? 'yes' : 'no'}`);
    }
  });

  if (!overrideEnabled && (!runId || Number.isNaN(runId))) {
    throw new Error('run_id is required (or action must run from workflow_run event)');
  }

  let octokit: Octokit | undefined;
  if (!overrideEnabled || verify) {
    const token = resolveAuthToken({
      tokenInput: core.getInput('token'),
      githubTokenInput: core.getInput('github_token'),
      envGithubToken: process.env.GITHUB_TOKEN,
      envGhToken: process.env.GH_TOKEN
    });
    core.setSecret(token);
    octokit = getOctokit(token);
  }

  const upstream = await resolveUpstreamRun(octokit, repository, runId || undefined);
  const producerTrust = upstream ? classifyProducerTrust(upstream.event) : 'unknown';
  const runJson = upstream ? runRecord(upstream) : undefined;
  const setRunOutputs = (): void => {
    core.setOutput('producer-trust', producerTrust);
    if (runJson) core.setOutput('run-json', JSON.stringify(runJson));
  };

  // Order matters: look the artifact up (GitHub metadata only), then run the checks that need only
  // GitHub's record of the producer run, and only then download and parse producer-written bytes.
  let artifactInfo: { id: number; name: string } | null = null;
  if (!overrideEnabled) {
    artifactInfo = await logger.withGroup('Bridge Consume: Find Artifact', () =>
      findBridgeArtifact(logger, octokit as Octokit, repository, runId, artifactName, failOnMissing)
    );
    if (!artifactInfo) {
      core.info('Bridge artifact not found and fail_on_missing=false; exiting without outputs.');
      core.setOutput('outputs-json', JSON.stringify({}));
      core.setOutput('meta-json', JSON.stringify({}));
      core.setOutput('event-json', JSON.stringify({}));
      if (verify) core.setOutput('verified-json', JSON.stringify({}));
      setRunOutputs();
      return;
    }
  }

  // Whether raw artifact values may be exposed; false only for an untrusted run accepted via verify.
  const raw = await logger.withGroup('Bridge Consume: Validate Producer Run', () => {
    if (!upstream) {
      if (verify) {
        throw new Error("verify: true needs GitHub's record of the producer run (a workflow_run event or run_id)");
      }
      logger.info('No GitHub record of a producer run is available; skipping producer run checks.');
      return true;
    }
    logger.info(`Producer run ${upstream.id}: event=${upstream.event}, trust=${producerTrust}`);
    const access = validateUpstreamRun(upstream, { sourceWorkflow, requireEvents, untrustedProducerEvents, verify });
    if (!access.raw) {
      logger.info('Untrusted producer accepted through verify: exposing only run.* and verified.* values.');
    }
    logger.info('Producer run validation passed.');
    return access.raw;
  });
  validateExtractRoots(mappings, { raw, verify });

  let bridge: LoadedBridge;
  if (artifactInfo) {
    const artifactId = artifactInfo.id;
    bridge = await logger.withGroup('Bridge Consume: Download Artifact', () =>
      downloadBridgeArtifact(logger, octokit as Octokit, repository, artifactId)
    );
  } else {
    bridge = await logger.withGroup('Bridge Consume: Load Override', () =>
      Promise.resolve(loadOverrideBridge(logger, overrideJson))
    );
  }

  await logger.withGroup('Bridge Consume: Validate Metadata', () => {
    validateExpectations(bridge.meta, runId || undefined, upstream);
    logger.info('Metadata validation passed.');
  });

  let verified: Verified | undefined;
  if (verify) {
    verified = await logger.withGroup('Bridge Consume: Verify', async () => {
      const result = await verifyProducerRun(octokit as Octokit, repository, upstream as UpstreamRun, bridge.meta);
      const parts = [
        result.trigger ? `${result.trigger.kind} ${result.trigger.id}` : '',
        result.pr ? `PR #${result.pr.number}` : ''
      ].filter(Boolean);
      logger.info(`Verified ${parts.join(' and ')} against the producer run.`);
      return result;
    });
  }

  if (raw && bridge.filesDir) {
    await logger.withGroup('Bridge Consume: Restore Files', async () => {
      const restored = await restoreBridgeFiles(bridge.filesDir as string, destination);
      if (restored) {
        logger.info(`Restored files to ${destination}`);
      } else {
        logger.info("No 'bridge/files' directory in artifact; skipping file restore.");
      }
    });
  } else if (raw && overrideEnabled) {
    await logger.withGroup('Bridge Consume: Restore Files', () => {
      logger.info('override_json mode does not support bridge/files restore; skipping.');
    });
  }

  await logger.withGroup('Bridge Consume: Expose Outputs', () => {
    if (raw) {
      for (const [key, value] of Object.entries(bridge.outputs)) {
        const outKey = `${prefix}${key}`;
        const stringValue = value === null ? 'null' : String(value);
        writeMaybeOutput(outKey, stringValue, expose);
      }
      logger.info(`Exposed ${Object.keys(bridge.outputs).length} bridge output keys.`);
      debugJson(logger, 'exposed output keys', Object.keys(bridge.outputs));
    }

    const roots = raw
      ? { outputs: bridge.outputs, meta: bridge.meta, event: bridge.meta.event || {} }
      : { outputs: {}, meta: {}, event: {} };
    const extracted = emitExtractedValues(mappings, { ...roots, run: runJson ?? {}, verified: verified ?? {} }, expose);
    if (extracted.length > 0) {
      logger.info(`Exposed ${extracted.length} extracted keys from mappings.`);
      debugJson(logger, 'extracted output keys', extracted);
    }
  });

  if (raw) {
    core.setOutput('outputs-json', JSON.stringify(bridge.outputs));
    core.setOutput('meta-json', JSON.stringify(bridge.meta));
    core.setOutput('event-json', JSON.stringify(bridge.meta.event || {}));
    if (bridge.filesDir) {
      core.setOutput('files-path', destination);
    }
  }
  if (verified) core.setOutput('verified-json', JSON.stringify(verified));
  setRunOutputs();

  if (bridge.tempDir) {
    await rm(bridge.tempDir, { recursive: true, force: true });
  }
  logger.info('Bridge consume completed.');
}

if (!process.env.VITEST) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  });
}
