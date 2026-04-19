export type HarnessToolName =
  | 'prepare_paid_request'
  | 'execute_prepared_request'
  | 'get_execution_result';

export type HarnessToolSpec = {
  name: HarnessToolName;
  description: string;
};

export const defaultHarnessInstructions =
  'Safely orchestrate paid HTTP requests through 402flow. Follow each tool\'s description for when and how to call it. Inspect challengeDetails and hints when present for merchant-published discovery data. Use externalMetadata only when the caller already has endpoint metadata, and treat it as advisory when merchant challenge hints disagree.';

export const defaultHarnessToolSpecs: HarnessToolSpec[] = [
  {
    name: 'prepare_paid_request',
    description: [
      'Probe a merchant URL and return normalized payment terms, request hints, validation issues, and a nextAction directive.',
      '',
      'Always call this before any paid execution.',
      '',
      'nextAction is the authoritative machine contract for what to do next:',
      '- "execute": the request is ready to pay. Call execute_prepared_request with the returned preparedId.',
      '- "revise_request": the request is incomplete. Inspect validationIssues and hints to determine what is missing. If the task provides enough information, fix the request and call prepare_paid_request again. Otherwise stop and explain what is still missing.',
      '- "treat_as_passthrough": the merchant does not require payment. Do not pay. Explain that paid execution is not required.',
      '',
      'Do not call execute_prepared_request unless nextAction is "execute".',
      'Do not invent missing business parameters.',
    ].join('\n'),
  },
  {
    name: 'execute_prepared_request',
    description:
      'Execute a previously prepared paid request. Only call this after prepare_paid_request returned nextAction "execute" for this preparedId. If the same preparedId was already executed, the harness rejects the duplicate call as already consumed. Prepare a new request to retry.',
  },
  {
    name: 'get_execution_result',
    description:
      'Read the stored execution result for a preparedId after execution completes. Always call this after execute_prepared_request before summarizing the outcome. Report denied, pending, failed, or inconclusive outcomes clearly.',
  },
];