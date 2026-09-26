import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * Phase 9's remote vector/object storage adapter surface (§7 "optional remote
 * vector/object storage adapters with tenant-bound filters"). Local-first stays
 * the default: the adapter is an interface plus one directory-backed
 * implementation, used only by a deployment that explicitly configures it.
 *
 * Objects are content-addressed (sha256) and namespaced by tenant, so one
 * tenant's reads can never address another tenant's bytes: the address *is*
 * `tenant/sha256`, and a mismatched body fails verification rather than
 * silently serving wrong content.
 */

export interface StoredObject {
  key: string
  sha256: string
  bytes: number
  storedAt: string
}

export interface RemoteObjectStore {
  /** Writes bytes under a tenant, returning the content address. Fails on hash mismatch. */
  put(tenant: string, bytes: Buffer): Promise<StoredObject>
  /** Reads one object; fails closed on missing key, cross-tenant access, or hash mismatch. */
  get(tenant: string, sha256: string): Promise<Buffer>
  /** Verifies every object under a tenant; returns the first inconsistency, or clean. */
  consistencyCheck(tenant: string): Promise<{ ok: true; objects: number } | { ok: false; key: string; reason: string }>
}

const sha256Pattern = /^[a-f0-9]{64}$/
const tenantPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function assertTenant(tenant: string): void {
  if (!tenantPattern.test(tenant)) throw new Error(`Tenant name is invalid: ${tenant}`)
}

export function assertSha256(sha256: string): void {
  if (!sha256Pattern.test(sha256)) throw new Error(`Not a sha256 address: ${sha256}`)
}

/**
 * A directory-backed store: `root/tenant/aa/bb/<sha>`. Content addressing makes
 * writes idempotent (same bytes, same address, no rewrite), and the fan-out
 * directory keeps any one directory from growing without bound.
 */
export class DirectoryObjectStore implements RemoteObjectStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  async put(tenant: string, bytes: Buffer): Promise<StoredObject> {
    assertTenant(tenant)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const path = this.objectPath(tenant, sha256)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
    }
    const storedAt = statSync(path).mtime.toISOString()
    return { key: `${tenant}/${sha256}`, sha256, bytes: bytes.length, storedAt }
  }

  async get(tenant: string, sha256: string): Promise<Buffer> {
    assertTenant(tenant)
    assertSha256(sha256)
    const path = this.objectPath(tenant, sha256)
    if (!existsSync(path)) throw new Error(`Object not found: ${tenant}/${sha256}`)
    const bytes = readFileSync(path)
    const actual = createHash('sha256').update(bytes).digest('hex')
    // Verification is part of the read, not a separate pass the caller may skip:
    // silent corruption or a mis-addressed object surfaces here, every time.
    if (actual !== sha256) throw new Error(`Object ${tenant}/${sha256} failed verification: content hashes to ${actual}`)
    return bytes
  }

  async consistencyCheck(tenant: string): Promise<{ ok: true; objects: number } | { ok: false; key: string; reason: string }> {
    assertTenant(tenant)
    const tenantRoot = join(this.root, tenant)
    if (!existsSync(tenantRoot)) return { ok: true, objects: 0 }
    let objects = 0
    const walk = (directory: string): { ok: true; objects: number } | { ok: false; key: string; reason: string } | undefined => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) {
          const nested = walk(path)
          if (nested) return nested
          continue
        }
        objects += 1
        const sha256 = entry
        const bytes = readFileSync(path)
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== sha256) return { ok: false, key: `${tenant}/${sha256}`, reason: `content hashes to ${actual}` }
        const expectedDirectory = join(this.root, tenant, sha256.slice(0, 2), sha256.slice(2, 4))
        if (dirname(path) !== expectedDirectory) return { ok: false, key: `${tenant}/${sha256}`, reason: 'object is filed under the wrong content directory' }
      }
      return undefined
    }
    const failure = walk(tenantRoot)
    return failure ?? { ok: true, objects }
  }

  /** Migration tooling (§7): re-verify every object and re-file any that drifted out of canonical layout. */
  reindex(): { moved: number; verified: number } {
    let moved = 0
    let verified = 0
    const walk = (directory: string, tenant: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) {
          walk(path, tenant)
          continue
        }
        if (!sha256Pattern.test(entry)) continue
        const bytes = readFileSync(path)
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== entry) continue // corrupt or foreign file: the consistency check reports it
        const target = this.objectPath(tenant, actual)
        if (target !== path) {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, bytes)
          rmSync(path)
          moved += 1
        }
        verified += 1
      }
    }
    for (const tenant of readdirSync(this.root)) {
      if (statSync(join(this.root, tenant)).isDirectory()) walk(join(this.root, tenant), tenant)
    }
    return { moved, verified }
  }

  private objectPath(tenant: string, sha256: string): string {
    return join(this.root, tenant, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  }
}

/**
 * The HTTP face of a store for remote replicas: PUT /<tenant>, GET /<tenant>/<sha>.
 * Every GET re-verifies the hash before answering, so a replica can trust what
 * it fetched without a second tool.
 *
 * Authenticated by a shared bearer token (C21: authenticated local HTTP — no
 * anonymous mutation surface): every request must carry it, and a request
 * without it is refused before the store is touched.
 */
export class ObjectStoreHttp {
  private readonly server: Server

  constructor(private readonly store: DirectoryObjectStore, private readonly token: string) {
    this.server = createServer((request, response) => void this.route(request, response))
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port))
    })
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())))
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if ((request.headers.authorization ?? '') !== `Bearer ${this.token}`) {
      replyJson(response, 401, { error: 'a valid bearer token is required' })
      return
    }
    const parts = (request.url ?? '/').split('/').filter((segment) => segment.length > 0)
    try {
      if (request.method === 'PUT' && parts.length === 1) {
        const body = await bodyOf(request, maxHttpBodyBytes)
        const stored = await this.store.put(parts[0], body)
        replyJson(response, 201, stored)
        return
      }
      if (request.method === 'GET' && parts.length === 2) {
        const bytes = await this.store.get(parts[0], parts[1])
        replyBytes(response, 200, bytes)
        return
      }
      replyJson(response, 404, { error: 'no such route' })
    } catch (error) {
      replyJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** A PUT body larger than this is refused before it is buffered, not after. */
const maxHttpBodyBytes = 32 * 1024 * 1024

async function bodyOf(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    received += (chunk as Buffer).length
    if (received > limitBytes) {
      request.destroy()
      throw new Error(`request body exceeds the ${limitBytes} byte limit`)
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function replyJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

function replyBytes(response: ServerResponse, status: number, bytes: Buffer): void {
  response.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
  response.end(bytes)
}
