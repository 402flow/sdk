import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function hostedSdk() {
  const bytes = await readFile(
    new URL('./402flow-sdk-0.1.3.tgz', import.meta.url),
  );
  return {
    version: '0.1.3' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    file: {
      type: 'inline',
      path: '/workspace/402flow-sdk-0.1.3.tgz',
      data: bytes.toString('base64'),
    },
    packages: { npm: ['undici@6.28.1', 'zod@3.25.76'] },
    setup_commands: [
      {
        command:
          'mkdir -p /workspace/node_modules/@402flow/sdk && tar -xzf /workspace/402flow-sdk-0.1.3.tgz -C /workspace/node_modules/@402flow/sdk --strip-components=1 && ln -s "$(npm root -g)/zod" /workspace/node_modules/zod && ln -s "$(npm root -g)/undici" /workspace/node_modules/undici',
      },
    ],
  };
}
