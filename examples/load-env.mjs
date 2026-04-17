import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const examplesDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(examplesDir, '..');

function stripMatchingQuotes(value) {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value.at(-1);

  if ((first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvLine(line) {
  const trimmed = line.trim();

  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null;
  }

  const withoutExport = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trim()
    : trimmed;
  const equalsIndex = withoutExport.indexOf('=');

  if (equalsIndex <= 0) {
    return null;
  }

  const name = withoutExport.slice(0, equalsIndex).trim();
  const rawValue = withoutExport.slice(equalsIndex + 1).trim();

  if (name.length === 0) {
    return null;
  }

  return {
    name,
    value: stripMatchingQuotes(rawValue),
  };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/u);

  for (const line of lines) {
    const entry = parseEnvLine(line);

    if (!entry || Object.prototype.hasOwnProperty.call(process.env, entry.name)) {
      continue;
    }

    process.env[entry.name] = entry.value;
  }
}

loadEnvFile(resolve(sdkRoot, '.env.local'));
loadEnvFile(resolve(sdkRoot, '.env'));