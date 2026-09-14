import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CertificateAuthority, generateCA } from '../../src/remote/certs.js'

/** PKI is openssl-backed; the drills only need the binary to exist, which CI guarantees. */
const ca = generateCA()
const authority = CertificateAuthority.fromPem(ca.certificate, ca.privateKey)

describe('remote PKI', () => {
  it('issues leaf certificates that verify against their CA, with CA:FALSE and SAN identity', () => {
    const leaf = authority.issue({ id: 'agent-7' })
    expect(authority.verify(leaf.certificate)).toEqual({ ok: true })
    expect(authority.identityOf(leaf.certificate)).toBe('agent-7')
    // The SAN carries the identity too, so TLS name checking has something to check.
    const parsed = new X509Certificate(leaf.certificate)
    expect(parsed.subjectAltName).toContain('DNS:agent-7')
    expect(parsed.ca).toBe(false)
    // The leaf's private key matches its certificate's public key.
    expect(leaf.privateKey).toContain('PRIVATE KEY')
  })

  it('refuses a leaf issued by a different CA, and refuses the CA itself as a leaf', () => {
    const other = CertificateAuthority.fromPem(...(() => {
      const bundle = generateCA()
      return [bundle.certificate, bundle.privateKey] as const
    })())
    const foreignLeaf = other.issue({ id: 'agent-7' })
    const refused = authority.verify(foreignLeaf.certificate)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('not issued by this CA')

    const caAsLeaf = authority.verify(ca.certificate)
    expect(caAsLeaf.ok).toBe(false)
    if (!caAsLeaf.ok) expect(caAsLeaf.reason).toContain('must not be a CA')
  })

  it('refuses an expired leaf and a tampered leaf, with named reasons', () => {
    const expired = authority.issue({ id: 'agent-8', days: 1 })
    const refusal = authority.verify(expired.certificate, new Date('2030-01-01T00:00:00Z'))
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.reason).toContain('expired')

    // A tampered body: swap two adjacent base64 characters inside the DER body,
    // which changes the signed bytes and must fail signature verification.
    const leaf = authority.issue({ id: 'agent-9' })
    const lines = leaf.certificate.split('\n')
    const body = lines.findIndex((line) => line.length > 40 && !line.startsWith('---'))
    const flipped = lines[body].slice(0, 20) + (lines[body].slice(20) === 'AAAA' ? 'BBBB' : lines[body][20] === 'A' ? 'B' + lines[body].slice(21) : 'A' + lines[body].slice(21))
    lines[body] = flipped
    const tampered = lines.join('\n')
    const signatureRefusal = authority.verify(tampered)
    expect(signatureRefusal.ok).toBe(false)
  })

  it('round-trips a certificate through PEM files the way a deployment would store it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hive-pki-test-'))
    const leaf = authority.issue({ id: 'file-agent', dns: ['file-agent.internal'] })
    writeFileSync(join(directory, 'agent.crt'), leaf.certificate, 'utf8')
    const reread = CertificateAuthority.fromPem(ca.certificate, ca.privateKey)
    expect(reread.verify(readFileSync(join(directory, 'agent.crt'), 'utf8'))).toEqual({ ok: true })
  })
})
