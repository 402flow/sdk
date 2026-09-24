import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

// Build and pack the local release candidate; never install a registry fallback.
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const destination = 'examples/openai-agents-api/dist';
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
execFileSync(
  'npm',
  ['pack', '--ignore-scripts', '--pack-destination', destination],
  {
    stdio: 'inherit',
  },
);
execFileSync(
  'npx',
  ['--no-install', 'tsc', '-p', 'examples/openai-agents-api/tsconfig.json'],
  {
    stdio: 'inherit',
  },
);
