# @402flow/sdk

Node.js SDK for making paid requests through the 402flow control plane.

## Install

```bash
npm install @402flow/sdk
```

## Usage

### Runtime Token

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
	controlPlaneBaseUrl: 'https://402flow.ai',
	auth: {
		type: 'runtimeToken',
		runtimeToken: process.env.AGENT_PAY_RUNTIME_TOKEN ?? '',
	},
});
```

### Bootstrap Key

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
	controlPlaneBaseUrl: 'https://402flow.ai',
	auth: {
		type: 'bootstrapKey',
		bootstrapKey: process.env.AGENT_PAY_BOOTSTRAP_KEY ?? '',
	},
});
```

When you configure `bootstrapKey` auth, the SDK exchanges that credential for a runtime token and reuses the runtime token for subsequent control-plane calls until it needs refresh.

## Runtime Requirements

Use this SDK from modern Node.js environments with built-in `fetch` support.

That matters because the SDK uses the Fetch API directly, not only when it calls `fetchPaid()`, but also when it normalizes headers and constructs response objects while mapping control-plane decisions back into SDK results. In practice, the SDK expects `fetch`, `Headers`, and `Response` to be available in the runtime.

The current target is modern Node.js with built-in Fetch API support.

## Repository Layout

The publishable npm package lives under `packages/sdk`.

This repository keeps the package source, tests, and publish configuration together in a small workspace, but the public consumer surface is the single package `@402flow/sdk`.

## Publish

The package is published from `packages/sdk`.
