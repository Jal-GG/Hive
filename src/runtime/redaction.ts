/**
 * Names whose values must never be inherited by accident or written to a record.
 * The list is deliberately broad: a false positive costs one explicit allowlist
 * entry, while a false negative writes a credential into an append-only log that
 * no later fix can unwrite.
 */
const SECRET_NAME = /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|COOKIE|SESSION|AUTH|AUTHORIZATION|PRIVATE|SIGNATURE|SALT|PIN|OTP)($|_)/i

export const redactedValue = '[redacted]'

/** Shapes that are secrets wherever they appear, independent of the name in front of them. */
const secretPatterns: RegExp[] = [
  // Provider key formats: sk-…, sk-ant-…, ghp_…, gho_…, xoxb-…, AKIA…, and JWTs.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // `Authorization: Bearer …` and friends, header or CLI flag spelling alike.
  /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // NAME=value and --flag=value where the name itself says "secret".
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi,
]

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name)
}

/**
 * Scrubs anything that looks like a credential out of text bound for an event,
 * audit record, or error message. Applied at the boundary rather than at each
 * call site, so no future payload field can forget it.
 */
export function redactText(text: string): string {
  let redacted = text
  for (const pattern of secretPatterns) redacted = redacted.replace(pattern, redactedValue)
  return redacted
}

/** Environment as it may be recorded: every name, no secret value. */
export function redactEnvironment(environment: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    safe[name] = isSecretName(name) ? redactedValue : redactText(value)
  }
  return safe
}

/**
 * Argv as it may be recorded. A value following a secret-looking flag is
 * redacted as well, since `--api-key` `abc` is two tokens and the second one
 * carries the secret.
 */
export function redactArguments(args: readonly string[]): string[] {
  const safe: string[] = []
  let redactNext = false
  for (const argument of args) {
    if (redactNext) {
      safe.push(redactedValue)
      redactNext = false
      continue
    }
    const flag = /^--?([A-Za-z0-9-]+)$/.exec(argument)
    if (flag && isSecretName(flag[1].replace(/-/g, '_'))) {
      safe.push(argument)
      redactNext = true
      continue
    }
    safe.push(redactText(argument))
  }
  return safe
}
