async function loadSdkMockSupport() {
  try {
    return await import('../../dist/index.js');
  } catch (distError) {
    try {
      return await import('../../src/index.ts');
    } catch {
      throw distError;
    }
  }
}

const { FetchPaidError } = await loadSdkMockSupport();

function cloneValue(value) {
  return structuredClone(value);
}

function stringifyResponseBody(body) {
  if (body === undefined) {
    return '';
  }

  return typeof body === 'string' ? body : JSON.stringify(body);
}

function buildResponse(response) {
  return new Response(stringifyResponseBody(response?.body), {
    status: response?.status ?? 200,
    headers: response?.headers ?? {},
  });
}

function hydrateExecuteOutcome(executeOutcome) {
  return {
    ...cloneValue(executeOutcome),
    response: buildResponse(executeOutcome.response),
  };
}

function validateOutcome(executeOutcome) {
  if (!executeOutcome || typeof executeOutcome !== 'object') {
    throw new Error('Mock executeOutcome must be an object.');
  }

  if (typeof executeOutcome.kind !== 'string') {
    throw new Error('Mock executeOutcome.kind must be a string.');
  }

  if (typeof executeOutcome.protocol !== 'string') {
    throw new Error('Mock executeOutcome.protocol must be a string.');
  }

  if (!executeOutcome.response || typeof executeOutcome.response !== 'object') {
    throw new Error('Mock executeOutcome.response must be an object.');
  }
}

export function createMockClient(mock) {
  if (!mock || typeof mock !== 'object') {
    throw new Error('Mock client configuration is required.');
  }

  if (!mock.prepareResult || typeof mock.prepareResult !== 'object') {
    throw new Error('Mock prepareResult must be an object.');
  }

  validateOutcome(mock.executeOutcome);

  return {
    async preparePaidRequest() {
      return cloneValue(mock.prepareResult);
    },

    async executePreparedRequest() {
      const outcome = hydrateExecuteOutcome(mock.executeOutcome);

      if (outcome.kind === 'success' || outcome.kind === 'passthrough') {
        return outcome;
      }

      throw new FetchPaidError(outcome);
    },
  };
}