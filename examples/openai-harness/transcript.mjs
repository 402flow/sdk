export function createOpenAiHarnessTranscript(input) {
  return {
    startedAt: input.startedAt ?? new Date().toISOString(),
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.scenario ? { scenario: input.scenario } : {}),
    model: input.model,
    prompt: input.prompt,
    maxTurns: input.maxTurns,
    preparedTtlMs: input.preparedTtlMs,
    instructions: input.instructions,
    toolCalls: [],
  };
}

export function appendOpenAiHarnessToolCall(transcript, toolCall) {
  return {
    ...transcript,
    toolCalls: [...transcript.toolCalls, toolCall],
  };
}

export function finalizeOpenAiHarnessTranscript(transcript, input) {
  return {
    ...transcript,
    completedAt: input.completedAt ?? new Date().toISOString(),
    finalResponseId: input.finalResponseId,
    finalText: input.finalText,
  };
}

export function serializeOpenAiHarnessTranscript(transcript) {
  return JSON.stringify(transcript, null, 2);
}