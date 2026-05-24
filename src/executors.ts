import type { DetectedChallenge } from './challenge-detection.js';
import type {
  PaidRequestContext,
  SdkDelegatedExecutionResult,
  SdkPaymentAuthorizationResponse,
  SdkPreparedPaidRequestReady,
} from './contracts.js';

export type DelegatedExecutePreparedRequest = Omit<
  PaidRequestContext,
  'organization' | 'agent'
> & {
  challenge?: DetectedChallenge;
  idempotencyKey?: string;
  executionProvider: string;
};

type AuthorizedExecution = Extract<
  SdkPaymentAuthorizationResponse,
  { outcome: 'authorized' }
>;

export type PreparedRequestExecutorInput = {
  prepared: SdkPreparedPaidRequestReady;
  authorization: AuthorizedExecution;
  request: DelegatedExecutePreparedRequest;
};

export type PreparedRequestExecutor = {
  provider: string;
  execute(input: PreparedRequestExecutorInput): Promise<SdkDelegatedExecutionResult>;
};