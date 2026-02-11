import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import AdmZip from 'adm-zip';

import { type BridgeMeta, type OutputsMap } from '../lib/schema.js';
import {
  getByPath,
  parseExtractMappings,
  parsePathList,
  readBridgeDirectory,
  restoreBridgeFiles,
  validateConsumerExpectations
} from '../lib/bridge.js';
import { createLogger, debugJson, type Logger } from '../lib/logging.js';
import { resolveAuthToken } from './token.js';

interface DownloadedBridge {
  meta: BridgeMeta;
  outputs: OutputsMap;
  filesDir: string;
  tempDir: string;
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

async function downloadBridgeArtifact(
  logger: Logger,
  token: string,
  repository: string,
  runId: number,
  artifactName: string,
  failOnMissing: boolean
): Promise<DownloadedBridge | null> {
  const [owner, repo] = repository.split('/');
  const octokit = getOctokit(token);

  const artifactsResp = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
    per_page: 100
  });
  logger.info(`Found ${artifactsResp.data.artifacts.length} artifacts on source run.`);
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

  const zipResp = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactInfo.id,
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

function validateExpectations(meta: BridgeMeta, runId: number): void {
  const expectedRepository = process.env.GITHUB_REPOSITORY || `${context.repo.owner}/${context.repo.repo}`;
  const sourceWorkflow = core.getInput('source_workflow');
  const expectedHeadSha = core.getInput('expected_head_sha');
  const expectedPrNumber = core.getInput('expected_pr_number');
  const requireEvent = parsePathList(core.getInput('require_event'));
  const triggerAttempt = context.payload.workflow_run?.run_attempt;

  validateConsumerExpectations(meta, {
    repository: expectedRepository,
    runId: String(runId),
    runAttempt: triggerAttempt ? String(triggerAttempt) : undefined,
    sourceWorkflow: sourceWorkflow || undefined,
    expectedHeadSha: expectedHeadSha || undefined,
    expectedPrNumber: expectedPrNumber || undefined,
    requireEvents: requireEvent
  });
}

function emitExtractedValues(
  outputs: OutputsMap,
  meta: BridgeMeta,
  expose: 'outputs' | 'env' | 'both'
): string[] {
  const extractRaw = core.getInput('extract');
  if (!extractRaw.trim()) return [];

  const mappings = parseExtractMappings(extractRaw);
  const extractedKeys: string[] = [];

  for (const mapping of mappings) {
    const value = getByPath({ outputs, meta, event: meta.event || {} }, mapping.path);
    if (value === undefined) {
      continue;
    }
    const serialized = value === null ? 'null' : String(value);
    writeMaybeOutput(mapping.name, serialized, expose);
    extractedKeys.push(mapping.name);
  }

  return extractedKeys;
}

export async function run(): Promise<void> {
  const logger = createLogger();
  const token = resolveAuthToken({
    tokenInput: core.getInput('token'),
    githubTokenInput: core.getInput('github_token'),
    envGithubToken: process.env.GITHUB_TOKEN,
    envGhToken: process.env.GH_TOKEN
  });

  const artifactName = core.getInput('artifact') || 'bridge';
  const runId = Number(core.getInput('run_id') || context.payload.workflow_run?.id);
  const failOnMissing = core.getBooleanInput('fail_on_missing', { required: false });
  const expose = parseExposeMode();
  const prefix = core.getInput('prefix') || '';
  const destination = path.resolve(core.getInput('path') || '.bridge');
  const repository = process.env.GITHUB_REPOSITORY || `${context.repo.owner}/${context.repo.repo}`;

  await logger.withGroup('Bridge Consume: Inputs', () => {
    logger.info(`Artifact name: ${artifactName}`);
    logger.info(`Source run id: ${String(runId || '(unset)')}`);
    logger.info(`Expose mode: ${expose}`);
    logger.info(`Output prefix: ${prefix || '(none)'}`);
    logger.info(`Restore path: ${destination}`);
    if (logger.debugEnabled) {
      logger.debug(`Repository: ${repository}`);
      logger.debug(`fail_on_missing: ${String(failOnMissing)}`);
      logger.debug(`source_workflow: ${core.getInput('source_workflow') || '(none)'}`);
      logger.debug(`expected_head_sha: ${core.getInput('expected_head_sha') || '(none)'}`);
      logger.debug(`expected_pr_number: ${core.getInput('expected_pr_number') || '(none)'}`);
      logger.debug(`require_event: ${core.getInput('require_event') || '(none)'}`);
      logger.debug(`extract mappings provided: ${core.getInput('extract') ? 'yes' : 'no'}`);
    }
  });

  if (!runId || Number.isNaN(runId)) {
    throw new Error('run_id is required (or action must run from workflow_run event)');
  }

  const bridge = await logger.withGroup('Bridge Consume: Download Artifact', () =>
    downloadBridgeArtifact(logger, token, repository, runId, artifactName, failOnMissing)
  );
  if (!bridge) {
    core.info('Bridge artifact not found and fail_on_missing=false; exiting without outputs.');
    core.setOutput('outputs-json', JSON.stringify({}));
    core.setOutput('meta-json', JSON.stringify({}));
    core.setOutput('event-json', JSON.stringify({}));
    return;
  }

  await logger.withGroup('Bridge Consume: Validate Metadata', () => {
    validateExpectations(bridge.meta, runId);
    logger.info('Metadata validation passed.');
  });

  await logger.withGroup('Bridge Consume: Restore Files', async () => {
    const restored = await restoreBridgeFiles(bridge.filesDir, destination);
    if (restored) {
      logger.info(`Restored files to ${destination}`);
    } else {
      logger.info("No 'bridge/files' directory in artifact; skipping file restore.");
    }
  });

  await logger.withGroup('Bridge Consume: Expose Outputs', () => {
    for (const [key, value] of Object.entries(bridge.outputs)) {
      const outKey = `${prefix}${key}`;
      const stringValue = value === null ? 'null' : String(value);
      writeMaybeOutput(outKey, stringValue, expose);
    }

    const extracted = emitExtractedValues(bridge.outputs, bridge.meta, expose);

    logger.info(`Exposed ${Object.keys(bridge.outputs).length} bridge output keys.`);
    if (extracted.length > 0) {
      logger.info(`Exposed ${extracted.length} extracted keys from mappings.`);
      debugJson(logger, 'extracted output keys', extracted);
    }
    debugJson(logger, 'exposed output keys', Object.keys(bridge.outputs));
  });

  core.setOutput('outputs-json', JSON.stringify(bridge.outputs));
  core.setOutput('meta-json', JSON.stringify(bridge.meta));
  core.setOutput('event-json', JSON.stringify(bridge.meta.event || {}));
  core.setOutput('files-path', destination);

  await rm(bridge.tempDir, { recursive: true, force: true });
  logger.info('Bridge consume completed.');
}

if (!process.env.VITEST) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  });
}
