#!/usr/bin/env node

import { AgentHarness } from '../dist/index.js';
import {
  createClientFromEnv,
  createOpenAiClient,
  createToolHandlers,
  defaultInstructions,
  defaultMaxTurns,
  defaultModel,
  getRequiredEnv,
  runOpenAiToolsSession,
} from './openai-tools-runtime.mjs';

function printHelp() {
  console.log(`Minimal OpenAI tools quickstart for @402flow/sdk

Usage:
  npm run example:openai-tools-quickstart -- "Prepare and execute a paid POST request to https://nickeljoke.vercel.app/api/joke with JSON body {\"topic\":\"sdk integration\",\"tone\":\"dry\",\"audience\":\"platform engineers\"}"

Required environment:
  OPENAI_API_KEY
  X402FLOW_CONTROL_PLANE_BASE_URL
  X402FLOW_ORGANIZATION
  X402FLOW_AGENT
  One of: X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN

Optional environment:
  OPENAI_MODEL           Default: ${defaultModel}
  OPENAI_MAX_TURNS       Default: ${defaultMaxTurns}
`);
}

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim();

  if (!prompt || prompt === '--help') {
    printHelp();
    process.exit(prompt ? 0 : 1);
  }

  const openai = createOpenAiClient(getRequiredEnv('OPENAI_API_KEY'));
  const harness = new AgentHarness({
    client: await createClientFromEnv('quickstart'),
  });
  const tools = createToolHandlers(harness);
  const maxTurns = Number(process.env.OPENAI_MAX_TURNS ?? defaultMaxTurns);
  const result = await runOpenAiToolsSession({
    openai,
    model: defaultModel,
    prompt,
    instructions: defaultInstructions,
    handlers: tools,
    maxTurns,
    onToolCall({ toolCall, result: toolResult }) {
      console.log(`\n[tool] ${toolCall.name}`);
      console.log(JSON.stringify(toolResult, null, 2));
    },
  });

  console.log(result.finalText);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});