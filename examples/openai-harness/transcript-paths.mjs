import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const helperDirectory = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(helperDirectory, '..', '..');

export const tmpDir = resolve(sdkRoot, 'tmp');
export const scenarioRunsDir = resolve(tmpDir, 'scenario-runs');
export const summaryPath = resolve(tmpDir, 'scenario-summary.txt');

export function formatTranscriptTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function defaultTranscriptFileForScenario(scenarioName, date = new Date()) {
  return createScenarioArtifactPaths(scenarioName, date).transcriptPath;
}

export function createScenarioArtifactPaths(scenarioName, date = new Date()) {
  const timestamp = formatTranscriptTimestamp(date);

  return {
    transcriptPath: resolve(scenarioRunsDir, `${scenarioName}-run-${timestamp}.json`),
    logPath: resolve(scenarioRunsDir, `${scenarioName}-run-${timestamp}.log`),
  };
}