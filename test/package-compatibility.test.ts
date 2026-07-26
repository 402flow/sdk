import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import adapterPackageJson from '../third-party-executors/package.json' with {
  type: 'json',
};

describe('package compatibility boundaries', () => {
  it('keeps the SDK and official adapter release in lockstep', () => {
    expect(adapterPackageJson.version).toBe(packageJson.version);
    expect(adapterPackageJson.peerDependencies['@402flow/sdk']).toBe(
      packageJson.version,
    );
    expect(adapterPackageJson.devDependencies['@402flow/sdk']).toBe('file:..');
  });

  it('keeps the declared Node floor aligned', () => {
    expect(packageJson.engines.node).toBe('>=20.0.0');
    expect(adapterPackageJson.engines.node).toBe('>=20.18.0');
  });

  it('keeps the root package ESM-only entrypoint explicit', () => {
    expect(packageJson.type).toBe('module');
    expect(packageJson.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    });
  });
});
