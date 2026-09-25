import type { PreparedRequestExecutor } from '@402flow/sdk';
import {
  createDexterExecutor,
  createPayShExecutor,
  type DexterExecutorOptions,
  type PayShExecutorOptions,
} from '@402flow/sdk-third-party-executors';
import {
  createDexterExecutor as createDirectDexterExecutor,
  type DexterExecutorOptions as DirectDexterOptions,
} from '@402flow/sdk-third-party-executors/dexter';
import {
  createPayShExecutor as createDirectPayShExecutor,
  type PayShExecutorOptions as DirectPayShOptions,
} from '@402flow/sdk-third-party-executors/pay-sh';

// Compile as an installed consumer; no signing or payment execution is needed.
export function createExecutors(
  wallets: DexterExecutorOptions['wallets'],
  signer: PayShExecutorOptions['signer'],
): PreparedRequestExecutor[] {
  const dexterOptions: DirectDexterOptions = { wallets };
  const payShOptions: DirectPayShOptions = {
    signer,
    networks: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
    fetch,
  };
  return [
    createDexterExecutor(dexterOptions),
    createPayShExecutor(payShOptions),
    createDirectDexterExecutor(dexterOptions),
    createDirectPayShExecutor(payShOptions),
  ];
}
