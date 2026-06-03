import type { PreparedRequestExecutor } from '@402flow/sdk';

import type { DexterExecutorOptions } from './dexter-executor.js';
import type { PayShExecutorOptions } from './pay-sh-executor.js';

export type { DexterExecutorOptions } from './dexter-executor.js';
export type { PayShExecutorOptions } from './pay-sh-executor.js';

function createLazyExecutor<Options>(
	provider: string,
	options: Options,
	loadExecutor: (resolvedOptions: Options) => Promise<PreparedRequestExecutor>,
): PreparedRequestExecutor {
	let loadedExecutorPromise: Promise<PreparedRequestExecutor> | undefined;

	return {
		provider,
		async execute(input) {
			loadedExecutorPromise ??= loadExecutor(options);

			return (await loadedExecutorPromise).execute(input);
		},
	};
}

export function createDexterExecutor(
	options: DexterExecutorOptions,
): PreparedRequestExecutor {
	return createLazyExecutor('dexter', options, async (resolvedOptions) => {
		const { createDexterExecutor: createResolvedDexterExecutor } = await import(
			'./dexter-executor.js'
		);

		return createResolvedDexterExecutor(resolvedOptions);
	});
}

export function createPayShExecutor(
	options: PayShExecutorOptions,
): PreparedRequestExecutor {
	return createLazyExecutor('pay_sh', options, async (resolvedOptions) => {
		const { createPayShExecutor: createResolvedPayShExecutor } = await import(
			'./pay-sh-executor.js'
		);

		return createResolvedPayShExecutor(resolvedOptions);
	});
}