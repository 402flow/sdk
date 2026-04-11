/**
 * Stable SDK metadata sent on every control-plane request.
 */
import packageJson from '../package.json' with { type: 'json' };

/** Header the SDK uses so the control plane can enforce contract compatibility. */
export const sdkClientVersionHeaderName = 'x-402flow-sdk-version';

/** Exact package version currently compiled into this SDK build. */
export const sdkClientVersion = packageJson.version;