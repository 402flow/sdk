# SDK project instructions

Applies to the core SDK and `third-party-executors/`. Keep authorization, policy,
approvals, receipts, and spend controls in the 402flow control plane. Read only
the task-relevant references below; examples and scenario setup belong there.

## Compatibility and payment safety

- Preserve public exports, TypeScript names, discriminants, serialized fields,
  and error contracts. Keep ESM and NodeNext declarations, Node 20 support for
  the core, and the adapter's Node 20.18 minimum. Preserve CI coverage for Node
  20/22 and TypeScript 5.8/5.9. Treat public contract changes as breaking under
  the documented pre-1.0 policy; do not infer relaxed compatibility from a tag.
- Before API, transport, challenge, or retry changes, read
  [the compatibility contract](docs/compatibility.md). Preserve runtime Zod
  validation, replayable paid bodies, exact prepared-request reconstruction
  without re-probing, and outcome-specific errors. Execute a prepared payment
  only when `kind === 'ready'` and `nextAction === 'execute'`.
- Add migration fixtures before changing challenge detection, amount selection,
  network handling, or header precedence. Retain v2, v1, legacy header, and JSON
  challenge support and preserve merchant-supplied network aliases.
- Never infer that a timeout or transport failure means no payment occurred.
  Reuse an idempotency key only for the same URL, method, body, agent identity,
  and business operation. Preserve the compatibility guide's retry table:
  denied requests require a policy/approval change; preflight failures require
  a fix; pending or lost responses keep the same key; inconclusive outcomes
  require reconciliation; hard failures require inspection; paid fulfillment
  failures require an explicit merchant recovery plan before another payment.
- Keep credentials out of source, logs, and reports. SDK examples use SDK-local
  environment configuration; do not borrow another project's credentials.
  Run paid scenarios and publish only within the user's authorized scope.

## Verification and releases

- For implementation changes, run relevant tests and `npm run check:all` for
  both packages. For packaging changes, also run `npm run pack:check` and the
  adapter's pack check. Preserve CI's installed-tarball import and consumer
  TypeScript checks. For instruction-only edits, check links, commands, and
  preserved requirements; paid/network campaigns are not needed.
- Before release work, read [the release procedure](docs/releasing.md) and
  [the scenario campaign](docs/harness-scenarios.md). Keep both package versions
  and the adapter's exact SDK peer dependency aligned; publish the core first,
  then the matching adapter. Keep prepublish checks. Do not publish customer
  demo URLs while `npm run smoke:hosted-demo` fails.
- The default release integration campaign is `npm run scenario:core`, which
  clears `tmp/` and includes three paid Base mainnet and three paid Solana
  mainnet scenarios. Preserve needed artifacts before running it. Each mainnet
  scenario must show `PASS`, `sdkOutcomeKind=success`, HTTP 200, `receiptId`,
  `paidRequestId`, and matching successful `execute_prepared_request` and stored
  `get_execution_result` transcript evidence. Both rails must be funded and
  enabled. If either cannot run, report the campaign as incomplete; offline
  checks or unpaid probes do not satisfy it.

## Task-specific references

- Client integration, request shaping, or delegated execution: read
  [the SDK guide](docs/sdk-guide.md); for provider adapters also read
  [the adapter guide](third-party-executors/README.md).
- Model-host wrappers and evaluation runner changes: read
  [the evaluation guide](docs/evaluation-harness.md). `AgentHarness` is
  process-local, not a durable orchestration store. Preserve concurrent-call
  sharing and consumed-execution rejection; explicit retries carry the original
  business idempotency key into a newly prepared request.
- Scenario setup, fixture selection, or live evaluation: read
  [the scenario guide](docs/harness-scenarios.md) before running commands.
