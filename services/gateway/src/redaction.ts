const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set(["tax_id", "bank_account"]);

function redactSensitiveText(value: string): string {
  return value
    .replace(/("tax_id"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED}$3`)
    .replace(/("bank_account"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED}$3`)
    .replace(/(tax_id\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/(bank_account\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`);
}

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(record)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        redacted[key] = REDACTED;
      } else {
        redacted[key] = redactSensitiveFields(nestedValue);
      }
    }
    return redacted;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  return value;
}
