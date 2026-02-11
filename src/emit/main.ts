import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as artifact from '@actions/artifact';
import * as core from '@actions/core';
import { context } from '@actions/github';

import { listFilesRecursively, parseJsonObject } from '../lib/schema.js';
import { buildBridgeMeta, parseAndMergeOutputs, parsePathList, pickByPaths, writeBridgeDirectory } from '../lib/bridge.js';
import { createLogger, debugJson } from '../lib/logging.js';

const MINIMAL_EVENT_PATHS = [
  'action',
  'sender.login',
  'sender.type',
  'issue.number',
  'issue.title',
  'issue.html_url',
  'issue.user.login',
  'comment.body',
  'comment.path',
  'comment.user.login',
  'review.body',
  'review.state',
  'review.user.login',
  'pull_request.number',
  'pull_request.title',
  'pull_request.html_url',
  'pull_request.user.login',
  'pull_request.base.ref',
  'pull_request.base.sha',
  'pull_request.base.repo.full_name',
  'pull_request.head.ref',
  'pull_request.head.sha',
  'pull_request.head.repo.full_name'
];

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseEventMode(value: string): 'none' | 'minimal' | 'full' {
  const normalized = value.trim() || 'minimal';
  if (normalized === 'none' || normalized === 'minimal' || normalized === 'full') {
    return normalized;
  }
  throw new Error(`Invalid include_event mode: ${value}`);
}

function buildEventMeta(mode: 'none' | 'minimal' | 'full', eventFieldsRaw: string): Record<string, unknown> | undefined {
  const eventFields = parsePathList(eventFieldsRaw);
  if (eventFields.length > 0) {
    return pickByPaths(context.payload, eventFields);
  }

  if (mode === 'none') {
    return undefined;
  }
  if (mode === 'full') {
    return context.payload as Record<string, unknown>;
  }
  return pickByPaths(context.payload, MINIMAL_EVENT_PATHS);
}

export async function run(): Promise<void> {
  const logger = createLogger();
  const artifactName = core.getInput('artifact') || 'bridge';
  const outputsRaw = core.getInput('outputs');
  const outputsFile = core.getInput('outputs_file');
  const filesRaw = core.getInput('files');
  const retentionRaw = core.getInput('retention_days');
  const sanitize = (core.getInput('sanitize') || 'strict') as 'strict' | 'none';
  const metaRaw = core.getInput('meta');
  const includeEvent = parseEventMode(core.getInput('include_event') || 'minimal');
  const eventFields = core.getInput('event_fields');
  const files = parseLines(filesRaw);

  await logger.withGroup('Bridge Emit: Inputs', () => {
    logger.info(`Artifact name: ${artifactName}`);
    logger.info(`Sanitize mode: ${sanitize}`);
    logger.info(`Files requested: ${files.length}`);
    logger.info(`Event mode: ${includeEvent}`);
    if (logger.debugEnabled) {
      logger.debug(`outputs_file: ${outputsFile || '(none)'}`);
      logger.debug(`retention_days: ${retentionRaw || '(default)'}`);
      logger.debug(`meta provided: ${metaRaw ? 'yes' : 'no'}`);
      logger.debug(`event_fields provided: ${eventFields ? 'yes' : 'no'}`);
    }
  });

  const outputs = await logger.withGroup('Bridge Emit: Build Payload', async () => {
    const parsed = parseAndMergeOutputs(
      outputsRaw,
      outputsFile ? await readFile(outputsFile, 'utf8') : '',
      sanitize
    );
    logger.info(`Output keys: ${Object.keys(parsed).length}`);
    debugJson(logger, 'output keys', Object.keys(parsed));
    return parsed;
  });

  let userMeta: Record<string, unknown> = {};
  if (metaRaw) {
    userMeta = parseJsonObject(metaRaw, 'meta');
    debugJson(logger, 'user meta', userMeta);
  }

  const eventMeta = buildEventMeta(includeEvent, eventFields);
  const bridgeMeta = buildBridgeMeta(
    {
      repository: process.env.GITHUB_REPOSITORY || `${context.repo.owner}/${context.repo.repo}`,
      workflowName: process.env.GITHUB_WORKFLOW || context.workflow,
      runId: process.env.GITHUB_RUN_ID || String(context.runId),
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
      eventName: context.eventName,
      headSha: process.env.GITHUB_SHA || context.sha,
      prNumber: context.payload.pull_request?.number ?? context.payload.issue?.number,
      producerJob: process.env.GITHUB_JOB
    },
    {
      ...userMeta,
      ...(eventMeta ? { event: eventMeta } : {})
    }
  );
  debugJson(logger, 'bridge meta', bridgeMeta);

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'bridge-emit-'));
  await logger.withGroup('Bridge Emit: Stage Artifact', async () => {
    await writeBridgeDirectory(tmpRoot, outputs, bridgeMeta, files);
    logger.info('Staged bridge payload directory.');
    if (logger.debugEnabled) {
      logger.debug(`staging root: ${tmpRoot}`);
      logger.debug(`staged files: ${files.length}`);
    }
  });

  await logger.withGroup('Bridge Emit: Upload Artifact', async () => {
    const filesToUpload = await listFilesRecursively(path.join(tmpRoot, 'bridge'));
    const retentionDays = retentionRaw ? Number(retentionRaw) : undefined;
    const client = new artifact.DefaultArtifactClient();
    const upload = await client.uploadArtifact(
      artifactName,
      filesToUpload,
      tmpRoot,
      retentionDays ? { retentionDays } : {}
    );
    logger.info(`Uploaded artifact '${artifactName}' with ${filesToUpload.length} files.`);
    debugJson(logger, 'upload result', upload);
  });

  core.setOutput('artifact', artifactName);
  core.setOutput('outputs-json', JSON.stringify(outputs));
  core.setOutput('meta-json', JSON.stringify(bridgeMeta));
  logger.info(`Bridge emit completed for artifact '${artifactName}'.`);
}

if (!process.env.VITEST) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  });
}
