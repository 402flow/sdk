import {
  monetaryAmountToMinorUnits,
  normalizedMoneySchema,
  type NormalizedMoney,
  type PaidRequestProtocol,
} from './contracts.js';

export type SupportedProtocol = PaidRequestProtocol;

export const defaultX402MoneyPrecision = 6;

export type X402PaymentRequirement = {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type X402PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  } & Record<string, unknown>;
  accepts: X402PaymentRequirement[];
};

export type X402PaymentResponse = Record<string, unknown>;

export type ParsedChallenge = {
  protocol: SupportedProtocol;
  money: NormalizedMoney;
  payee?: string;
  raw: Record<string, unknown>;
};

export function readX402RequirementAmount(requirement: X402PaymentRequirement) {
  return requirement.amount ?? requirement.maxAmountRequired;
}

export function createParsedChallenge(input: {
  protocol: SupportedProtocol;
  money: NormalizedMoney;
  payee: string | undefined;
  raw: Record<string, unknown>;
}): ParsedChallenge {
  return {
    protocol: input.protocol,
    money: input.money,
    raw: input.raw,
    ...(input.payee ? { payee: input.payee } : {}),
  };
}

export function minorUnitsToMonetaryAmount(amountMinor: string, precision: number) {
  if (!/^\d+$/.test(amountMinor)) {
    throw new Error('Invalid minor-unit amount format.');
  }

  if (precision === 0) {
    return amountMinor;
  }

  const normalizedMinorUnits = amountMinor.padStart(precision + 1, '0');
  const wholePart = normalizedMinorUnits.slice(0, -precision) || '0';
  const fractionalPart = normalizedMinorUnits.slice(-precision);

  return `${wholePart}.${fractionalPart}`;
}

export function decodeBase64JsonObject(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const decodeBase64 =
    typeof globalThis.atob === 'function'
      ? globalThis.atob.bind(globalThis)
      : (input: string) => Buffer.from(input, 'base64').toString('binary');
  const binary = decodeBase64(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoded = new TextDecoder().decode(bytes);

  return JSON.parse(decoded) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isX402PaymentRequirement(
  value: unknown,
): value is X402PaymentRequirement {
  return (
    isRecord(value) &&
    typeof value.scheme === 'string' &&
    typeof value.network === 'string' &&
    (typeof value.amount === 'string' || typeof value.maxAmountRequired === 'string')
  );
}

export function isX402PaymentRequired(value: unknown): value is X402PaymentRequired {
  return (
    isRecord(value) &&
    typeof value.x402Version === 'number' &&
    Array.isArray(value.accepts) &&
    value.accepts.every((accept) => isX402PaymentRequirement(accept))
  );
}

export function inferX402Precision(requirement: X402PaymentRequirement) {
  const extra = requirement.extra;

  if (!isRecord(extra)) {
    return defaultX402MoneyPrecision;
  }

  const precisionCandidate = extra.precision ?? extra.decimals;
  const precision = Number(precisionCandidate);

  if (!Number.isFinite(precision) || precision < 0) {
    return defaultX402MoneyPrecision;
  }

  return precision;
}

export function createParsedChallengeFromPaymentRequired(input: {
  protocol: SupportedProtocol;
  paymentRequired: X402PaymentRequired;
  raw: Record<string, unknown>;
}) {
  const firstRequirement = input.paymentRequired.accepts[0];

  if (!firstRequirement) {
    return undefined;
  }

  const requirementAmount = readX402RequirementAmount(firstRequirement);

  if (!requirementAmount) {
    return undefined;
  }

  const precision = inferX402Precision(firstRequirement);
  const amount = minorUnitsToMonetaryAmount(requirementAmount, precision);
  const asset = firstRequirement.asset ?? 'UNKNOWN';
  const payee = firstRequirement.payTo;

  return createParsedChallenge({
    protocol: input.protocol,
    money: normalizedMoneySchema.parse({
      asset,
      amount,
      amountMinor: requirementAmount,
      precision,
      unit: 'minor',
    }),
    payee,
    raw: input.raw,
  });
}

export function createParsedChallengeFromExplicitHeaders(input: {
  protocol: SupportedProtocol;
  amount: string;
  asset: string;
  precision: number;
  payee?: string;
  raw: Record<string, unknown>;
}) {
  return createParsedChallenge({
    protocol: input.protocol,
    money: normalizedMoneySchema.parse({
      asset: input.asset,
      amount: input.amount,
      amountMinor: monetaryAmountToMinorUnits(input.amount, input.precision),
      precision: input.precision,
      unit: 'minor',
    }),
    payee: input.payee,
    raw: input.raw,
  });
}

export function getX402PaymentRequired(challenge: ParsedChallenge) {
  const paymentRequired = challenge.raw.paymentRequired;

  if (!isX402PaymentRequired(paymentRequired)) {
    return undefined;
  }

  return paymentRequired;
}