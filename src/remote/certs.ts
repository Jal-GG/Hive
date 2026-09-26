import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'

/**
 * Phase 9's internal PKI: one offline CA per deployment, leaf certificates per
 * ExecutionAgent, identity carried as the leaf's Common Name and DNS SAN.
 *
 * The CA private key never lives in the ledger — it is a PEM the operator
 * generates and keeps offline. Verification is fail-closed: no issuer match, no
 * valid period, or a self-issued leaf means the connection never opens.
 *
 * Certificates are generated with `openssl` rather than a JS dependency, so the
 * trust anchor is a real X.509 chain any standard tool can also verify.
 */

export interface PkiIdentity {
  /** The certificate's Common Name — the agent or authority identity, e.g. `agent-7` or `hive-ca`. */
  id: string
  /** DNS SANs, always including the CN so identity is SAN-checked too. */
  dns?: readonly string[]
  /** IP SANs, for loopback listeners whose hostname check is an IP literal. */
  ips?: readonly string[]
  /** Days the certificate is valid. */
  days?: number
}

export interface CertificateBundle {
  /** PEM-encoded certificate. */
  certificate: string
  /** PEM-encoded private key. */
  privateKey: string
}

export const caIdentity = 'hive-ca'
export const minimumKeyBits = 2048

/** A scratch directory per certificate operation; openssl needs real files for `-CA`/`-CAkey`. */
class Scratch {
  readonly directory: string

  constructor() {
    this.directory = mkdtempSync(join(tmpdir(), 'hive-pki-'))
  }

  file(name: string, content: string): string {
    const path = join(this.directory, name)
    writeFileSync(path, content, 'utf8')
    return path
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true })
  }
}

/** One authority bundle + the verification rule every leaf must pass. */
export class CertificateAuthority {
  constructor(private readonly bundle: CertificateBundle) {}

  static fromPem(certificate: string, privateKey: string): CertificateAuthority {
    return new CertificateAuthority({ certificate, privateKey })
  }

  certificatePem(): string {
    return this.bundle.certificate
  }

  privateKeyPem(): string {
    return this.bundle.privateKey
  }

  /**
   * Issues a leaf certificate for one identity. The leaf is signed by the CA
   * key and carries `CA:FALSE`, so a compromised agent cannot mint further
   * certificates: chain verification stops at exactly the depth the deployment
   * authorizes.
   */
  issue(identity: PkiIdentity): CertificateBundle {
    const key = generateKey()
    const scratch = new Scratch()
    try {
      const san = [
        `DNS:${identity.id}`,
        ...(identity.dns ?? []).map((name) => `DNS:${name}`),
        ...(identity.ips ?? []).map((address) => `IP:${address}`),
      ].join(',')
      // Two steps, because `openssl req -CA` support varies by build while
      // `openssl x509 -req -CA` is the portable signing path: CSR, then sign.
      const csr = openssl([
        'req', '-new', '-key', scratch.file('leaf.key', key.privateKey),
        '-subj', `/CN=${identity.id}`,
        '-addext', `subjectAltName=${san}`,
        '-addext', 'basicConstraints=critical,CA:FALSE',
      ])
      const certificate = openssl([
        'x509', '-req', '-in', scratch.file('leaf.csr', csr),
        '-CA', scratch.file('ca.pem', this.bundle.certificate),
        '-CAkey', scratch.file('ca-key.pem', this.bundle.privateKey),
        '-CAcreateserial', '-days', String(identity.days ?? 825),
        '-copy_extensions', 'copyall',
      ])
      return { certificate, privateKey: key.privateKey }
    } finally {
      scratch.dispose()
    }
  }

  /**
   * Fail-closed verification of a peer's leaf. Every rule is explicit so a
   * mis-issued certificate fails with a named reason rather than a TLS mystery.
   */
  verify(leafPem: string, now = new Date()): { ok: true } | { ok: false; reason: string } {
    let leaf: X509Certificate
    let ca: X509Certificate
    try {
      leaf = new X509Certificate(leafPem)
      ca = new X509Certificate(this.bundle.certificate)
    } catch {
      return { ok: false, reason: 'certificate is not parseable PEM' }
    }
    if (leaf.ca) return { ok: false, reason: 'leaf must not be a CA certificate' }
    if (!leaf.checkIssued(ca)) return { ok: false, reason: 'leaf was not issued by this CA' }
    if (!leaf.verify(ca.publicKey)) return { ok: false, reason: 'leaf signature does not verify' }
    if (!leaf.validFromDate || !leaf.validToDate) return { ok: false, reason: 'leaf has no validity period' }
    if (now < new Date(leaf.validFromDate)) return { ok: false, reason: 'leaf is not yet valid' }
    if (now > new Date(leaf.validToDate)) return { ok: false, reason: 'leaf has expired' }
    return { ok: true }
  }

  /** The identity a verified leaf carries: its Common Name. */
  identityOf(leafPem: string): string | undefined {
    try {
      return new X509Certificate(leafPem).subject.split('\n')
        .find((line) => line.startsWith('CN='))
        ?.slice('CN='.length)
    } catch {
      return undefined
    }
  }
}

/** Generates a fresh CA bundle. The operator keeps the key offline thereafter. */
export function generateCA(days = 3650): CertificateBundle {
  const key = generateKey()
  const scratch = new Scratch()
  try {
    const certificate = openssl([
      'req', '-x509', '-new', '-key', scratch.file('ca-self.key', key.privateKey),
      '-days', String(days),
      '-subj', `/CN=${caIdentity}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', `subjectAltName=DNS:${caIdentity}`,
    ])
    return { certificate, privateKey: key.privateKey }
  } finally {
    scratch.dispose()
  }
}

export function generateKey(bits = minimumKeyBits): CertificateBundle {
  const privateKey = openssl(['genrsa', String(bits)])
  return { certificate: '', privateKey }
}

let resolvedBinary: string | undefined

/**
 * Where openssl is found, probed once and memoized. PATH first; Git for
 * Windows bundles a real openssl (usr/bin and mingw64/bin both carry it),
 * which covers Windows machines that never installed openssl separately.
 */
function opensslBinary(): string {
  if (resolvedBinary) return resolvedBinary
  const candidates = [
    'openssl',
    join('C:', 'Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
    join('C:', 'Program Files', 'Git', 'mingw64', 'bin', 'openssl.exe'),
  ]
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
      resolvedBinary = candidate
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('openssl was not found on PATH or in the Git for Windows bundle; the remote PKI requires it')
}

function openssl(argv: readonly string[], stdin?: string): string {
  try {
    return execFileSync(opensslBinary(), [...argv], {
      input: stdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    const detail = error as { stderr?: string; message: string }
    const reason = `${detail.stderr ?? ''}`.trim() || detail.message
    throw new Error(`openssl ${argv[0]} failed: ${reason}`)
  }
}
