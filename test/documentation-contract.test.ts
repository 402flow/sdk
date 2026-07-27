import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function read(relativePath: string) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('customer documentation contract', () => {
  it('keeps local Markdown links valid', () => {
    for (const relativePath of [
      'README.md',
      'docs/sdk-guide.md',
      'docs/compatibility.md',
      'third-party-executors/README.md',
    ]) {
      const markdown = read(relativePath);
      const linkTargets = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
        .map((match) => match[1]!)
        .filter((target) =>
          !target.startsWith('http')
          && !target.startsWith('#')
          && !target.startsWith('mailto:'))
        .map((target) => target.split('#')[0]!)
        .filter(Boolean);

      for (const target of linkTargets) {
        expect(
          fs.existsSync(path.resolve(
            path.dirname(path.join(repositoryRoot, relativePath)),
            target,
          )),
          `${relativePath} links to missing ${target}`,
        ).toBe(true);
      }
    }
  });

  it('links to strict TypeScript examples and narrows PaidResponse', () => {
    const readme = read('README.md');

    expect(readme).toContain('examples/typescript/fetch-paid.ts');
    expect(readme).toContain('examples/typescript/prepare-execute.ts');
    expect(readme).toContain('examples/typescript/timeout-client.ts');
    expect(readme).toContain("result.kind === 'success'");
    expect(readme).not.toMatch(
      /console\.log\(result\.receiptId\);\s*```/,
    );
  });

  it('publishes and smoke-checks every hosted integration target', () => {
    const readme = read('README.md');
    const smokeScript = read('scripts/check-hosted-demo.mjs');

    for (const route of [
      '/demo-merchant/research-brief/base-sepolia',
      '/demo-merchant/research-brief/base-mainnet',
      '/demo-merchant/research-brief/solana-devnet',
      '/demo-merchant/research-brief/solana-mainnet',
    ]) {
      expect(readme).toContain(route);
      expect(smokeScript).toContain(route);
    }

    expect(readme).toContain('0.006 USDC');
    expect(readme).toContain('npm run scenario:core');
    expect(readme).toContain('funded Base and Solana mainnet rails');
  });

  it('publishes the compatibility and safe-retry contract', () => {
    const compatibility = read('docs/compatibility.md');

    for (const heading of [
      'Public API stability',
      'Error taxonomy',
      'Semver boundaries',
      'Runtime and TypeScript compatibility',
      'Request and response contracts',
      'Safe retries',
      'Older x402 behavior',
    ]) {
      expect(compatibility).toContain(`## ${heading}`);
    }

    for (const outcome of [
      'denied',
      'preflight_failed',
      'execution_pending',
      'execution_failed',
      'paid_fulfillment_failed',
      'execution_inconclusive',
      'request_failed',
    ]) {
      expect(compatibility).toContain(`\`${outcome}\``);
    }
  });
});
