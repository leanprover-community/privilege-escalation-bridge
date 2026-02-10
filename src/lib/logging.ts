import * as core from '@actions/core';

export interface Logger {
  debugEnabled: boolean;
  info(message: string): void;
  debug(message: string): void;
  warning(message: string): void;
  startGroup(title: string): void;
  endGroup(): void;
  withGroup<T>(title: string, fn: () => Promise<T> | T): Promise<T>;
}

function isDebugEnabled(): boolean {
  return process.env.RUNNER_DEBUG === '1' || process.env.ACTIONS_STEP_DEBUG === 'true';
}

export function createLogger(): Logger {
  const debugEnabled = isDebugEnabled();

  return {
    debugEnabled,
    info: (message: string) => core.info(message),
    debug: (message: string) => core.debug(message),
    warning: (message: string) => core.warning(message),
    startGroup: (title: string) => core.startGroup(title),
    endGroup: () => core.endGroup(),
    async withGroup<T>(title: string, fn: () => Promise<T> | T): Promise<T> {
      core.startGroup(title);
      try {
        return await fn();
      } finally {
        core.endGroup();
      }
    }
  };
}

export function debugJson(logger: Logger, label: string, value: unknown): void {
  if (!logger.debugEnabled) {
    return;
  }
  logger.debug(`${label}: ${JSON.stringify(value, null, 2)}`);
}
