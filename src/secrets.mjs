// A contract gets committed: whatever looks like a credential becomes an environment variable.
import { ContractError } from './contract.mjs';

export const ENV_PREFIX = 'DRIFTPROBE_';
export const TOKEN_PREFIX_RE = /^(?:sk|pk|rk|xox[a-z]?|gh[pousr]|bot)[-_]/i;

const SECRET_NAME_RE = /key|token|secret|auth|sig|pass|pwd|cred|jwt|session|bearer|(?:^|[_-])sid(?:$|[_-])/i;
const OPAQUE_MIN_LENGTH = 20;
const SLUG_RE = /^[a-z]+(?:[-_][a-z0-9]+)*$/;
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
const WHOLE_VARIABLE_RE = /^\$\{\w+\}$/;
const ENCODED_VARIABLE_RE = /\$%7B(\w+)%7D/g;

const hasVariable = (text) => text.includes('${');
const variableFor = (name) => `${ENV_PREFIX}${name.toUpperCase().replace(/\W+/g, '_')}`;
const reference = (variable) => `\${${variable}}`;

// Long, mixes letters and digits, and is neither a readable slug nor a date.
function looksOpaque(value) {
  if (value.length < OPAQUE_MIN_LENGTH || /\s/.test(value)) return false;
  if (SLUG_RE.test(value) || DATE_PREFIX_RE.test(value)) return false;
  return /[a-z]/i.test(value) && /\d/.test(value);
}

const looksSecret = (value) => !hasVariable(value) && (TOKEN_PREFIX_RE.test(value) || looksOpaque(value));

function withoutSecretPath(pathname, warn) {
  let count = 0;
  return pathname
    .replace(ENCODED_VARIABLE_RE, '${$1}')
    .split('/')
    .map((segment) => {
      if (!looksSecret(segment)) return segment;
      count += 1;
      const variable = variableFor(`PATH_${count}`);
      warn(variable);
      return reference(variable);
    })
    .join('/');
}

function withoutSecretQuery(searchParams, warn) {
  const parts = [...searchParams].map(([name, value]) => {
    const encodedName = encodeURIComponent(name);
    if (WHOLE_VARIABLE_RE.test(value)) return `${encodedName}=${value}`;
    if (!SECRET_NAME_RE.test(name) && !looksSecret(value)) return `${encodedName}=${encodeURIComponent(value)}`;
    const variable = variableFor(name);
    warn(variable);
    return `${encodedName}=${reference(variable)}`;
  });
  return parts.length ? `?${parts.join('&')}` : '';
}

/** @param {(variable: string) => void} warn told about each variable the user must now set */
export function withoutSecrets(text, warn) {
  const url = new URL(text);
  if (url.username || url.password) throw new ContractError('credentials in the URL: use ${VARIABLES} and the environment instead');
  return url.origin + withoutSecretPath(url.pathname, warn) + withoutSecretQuery(url.searchParams, warn);
}

function cleanArgument(name, value, warn) {
  if (Array.isArray(value)) return value.map((entry) => cleanArgument(name, entry, warn));
  if (value !== null && typeof value === 'object') return withoutSecretArguments(value, warn);
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const text = String(value);
  if (hasVariable(text) || !(SECRET_NAME_RE.test(name) || looksSecret(text))) return value;
  const variable = variableFor(name);
  warn(variable);
  return reference(variable);
}

export function withoutSecretArguments(args, warn) {
  return Object.fromEntries(Object.entries(args ?? {}).map(([name, value]) => [name, cleanArgument(name, value, warn)]));
}
