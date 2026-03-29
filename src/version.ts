import packageJson from '../package.json' with { type: 'json' };

export const sdkClientVersionHeaderName = 'x-402flow-sdk-version';
export const sdkClientVersion = packageJson.version;