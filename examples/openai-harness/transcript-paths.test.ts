import { describe, expect, it } from 'vitest';

import {
  createScenarioArtifactPaths,
  defaultTranscriptFileForScenario,
  scenarioRunsDir,
} from './transcript-paths.mjs';

describe('openai agent harness transcript path helpers', () => {
  it('places default scenario transcripts under tmp/scenario-runs with a timestamped name', () => {
    const path = defaultTranscriptFileForScenario(
      'solana-devnet-research-brief-ready',
      new Date('2026-04-17T22:55:34.466Z'),
    );

    expect(path).toBe(
      `${scenarioRunsDir}/solana-devnet-research-brief-ready-run-20260417T225534Z.json`,
    );
  });

  it.each([
    'solana-devnet-research-brief-bazaar-revise',
    'base-mainnet-research-brief-ready',
  ])('uses matching transcript and log timestamps for %s', (scenario) => {
    const paths = createScenarioArtifactPaths(
      scenario,
      new Date('2026-04-17T22:55:34.466Z'),
    );
    expect(paths).toEqual({
      transcriptPath: `${scenarioRunsDir}/${scenario}-run-20260417T225534Z.json`,
      logPath: `${scenarioRunsDir}/${scenario}-run-20260417T225534Z.log`,
    });
  });
});
