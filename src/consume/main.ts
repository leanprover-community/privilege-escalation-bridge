import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import AdmZip from 'adm-zip';

import { ensureDir, type BridgeMeta, type OutputsMap } from '../lib/schema.js';
import { readBridgeDirectory, validateConsumerExpectations } from '../lib/bridge.js';
import { createLogger, debugJson, type Logger } from '../lib/logging.js';

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

function parseRequiredEvents(input: string): string[] {
  if (!input.trim()) return [];
  return input
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
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
  const requireEvent = parseRequiredEvents(core.getInput('require_event'));
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

async function run(): Promise<void> {
  const logger = createLogger();
  const token = core.getInput('github_token') || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to download artifacts');
  }

  const name = core.getInput('name') || 'bridge';
  const runId = Number(core.getInput('run_id') || context.payload.workflow_run?.id);
  const failOnMissing = core.getBooleanInput('fail_on_missing', { required: false });
  const expose = parseExposeMode();
  const prefix = core.getInput('prefix') || '';
  const destination = path.resolve(core.getInput('path') || '.bridge');
  const repository = process.env.GITHUB_REPOSITORY || `${context.repo.owner}/${context.repo.repo}`;

  await logger.withGroup('Bridge Consume: Inputs', () => {
    logger.info(`Artifact name: ${name}`);
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
    }
  });

  if (!runId || Number.isNaN(runId)) {
    throw new Error('run_id is required (or action must run from workflow_run event)');
  }

  const bridge = await logger.withGroup('Bridge Consume: Download Artifact', () =>
    downloadBridgeArtifact(logger, token, repository, runId, name, failOnMissing)
  );
  if (!bridge) {
    core.info('Bridge artifact not found and fail_on_missing=false; exiting without outputs.');
    core.setOutput('outputs', JSON.stringify({}));
    return;
  }

  await logger.withGroup('Bridge Consume: Validate Metadata', () => {
    validateExpectations(bridge.meta, runId);
    logger.info('Metadata validation passed.');
  });

  await logger.withGroup('Bridge Consume: Restore Files', async () => {
    await ensureDir(destination);
    await cp(bridge.filesDir, destination, { recursive: true, force: true });
    logger.info(`Restored files to ${destination}`);
  });

  await logger.withGroup('Bridge Consume: Expose Outputs', () => {
    for (const [key, value] of Object.entries(bridge.outputs)) {
      const outKey = `${prefix}${key}`;
      const stringValue = value === null ? 'null' : String(value);

      if (expose === 'outputs' || expose === 'both') {
        core.setOutput(outKey, stringValue);
      }
      if (expose === 'env' || expose === 'both') {
        core.exportVariable(outKey, stringValue);
      }
    }
    logger.info(`Exposed ${Object.keys(bridge.outputs).length} output keys.`);
    debugJson(logger, 'exposed output keys', Object.keys(bridge.outputs));
  });

  core.setOutput('outputs', JSON.stringify(bridge.outputs));
  core.setOutput('files-path', destination);

  await rm(bridge.tempDir, { recursive: true, force: true });
  logger.info('Bridge consume completed.');
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
});
