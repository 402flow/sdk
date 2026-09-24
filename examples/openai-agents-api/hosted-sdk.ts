import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sdkClientVersion } from '@402flow/sdk';
import { z } from 'zod';

// Version metadata does not select an artifact during cleanup. Accept older
// reports without tying recovery to the version installed by the caller today.
export const sdkVersionSchema = z.string().max(128).regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);

export async function hostedSdk() {
  const version = sdkVersionSchema.parse(sdkClientVersion);
  const filename = `402flow-sdk-${version}.tgz`;
  const bytes = await readFile(
    new URL(`./${filename}`, import.meta.url),
  );
  return {
    version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    file: {
      type: 'inline',
      path: `/workspace/${filename}`,
      data: bytes.toString('base64'),
    },
    packages: { npm: ['undici@6.28.1', 'zod@3.25.76'] },
    setup_commands: [
      {
        command:
          `mkdir -p /workspace/node_modules/@402flow/sdk && tar -xzf /workspace/${filename} -C /workspace/node_modules/@402flow/sdk --strip-components=1 && ln -s "$(npm root -g)/zod" /workspace/node_modules/zod && ln -s "$(npm root -g)/undici" /workspace/node_modules/undici`,
      },
    ],
  };
}
