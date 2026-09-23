import '../load-env.mjs';
import { main } from './dist/cli.js';
import { ProbeError } from './dist/transport.js';

try {
  await main();
} catch (error) {
  // Never print raw exceptions, stacks, argv, environment, or provider bodies.
  console.error(error instanceof ProbeError ? error.code : 'probe_command_failed');
  process.exitCode = 1;
}
