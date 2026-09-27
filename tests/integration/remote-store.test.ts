import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DirectoryObjectStore, ObjectStoreHttp } from '../../src/remote/object-store.js'
import { objectStoreLoadRun } from '../../src/remote/load.js'

describe('remote object store', () => {
  it('stores content-addressed, tenant-bound objects and verifies every read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-store-test-'))
    const store = new DirectoryObjectStore(join(root, 'objects'))

    const bytes = Buffer.from('tenant alpha content')
    const stored = await store.put('alpha', bytes)
    expect(stored.bytes).toBe(bytes.length)
    expect(await store.get('alpha', stored.sha256)).toEqual(bytes)

    // The same bytes put again are the same address: idempotent, no rewrite.
    const again = await store.put('alpha', bytes)
    expect(again.sha256).toBe(stored.sha256)

    // A different tenant cannot read alpha's object by address.
    await expect(store.get('beta', stored.sha256)).rejects.toThrow(/not found/)
    const beta = await store.put('beta', Buffer.from('beta content'))
    expect(beta.sha256).not.toBe(stored.sha256)
  })

  it('fails closed on a corrupted object and reports it in the consistency check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-store-test-'))
    const store = new DirectoryObjectStore(join(root, 'objects'))
    const stored = await store.put('alpha', Buffer.from('integrity target'))

    // Corrupt the stored bytes behind the store's back.
    writeFileSync(join(root, 'objects', 'alpha', stored.sha256.slice(0, 2), stored.sha256.slice(2, 4), stored.sha256), 'corrupted', 'utf8')
    await expect(store.get('alpha', stored.sha256)).rejects.toThrow(/failed verification/)
    const check = await store.consistencyCheck('alpha')
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('hashes to')
  })

  it('reindexes drifted objects back into canonical layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-store-test-'))
    const store = new DirectoryObjectStore(join(root, 'objects'))
    const stored = await store.put('alpha', Buffer.from('reindex target'))

    // Move the object into a flat, non-canonical location, the way an old
    // layout or a partial migration would leave it.
    const flat = join(root, 'objects', 'alpha', stored.sha256)
    const canonical = join(root, 'objects', 'alpha', stored.sha256.slice(0, 2), stored.sha256.slice(2, 4), stored.sha256)
    const { renameSync, rmSync } = await import('node:fs')
    renameSync(canonical, flat)
    rmSync(join(root, 'objects', 'alpha', stored.sha256.slice(0, 2)), { recursive: true, force: true })

    const result = store.reindex()
    expect(result.moved).toBe(1)
    expect(result.verified).toBe(1)
    const check = await store.consistencyCheck('alpha')
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.objects).toBe(1)
    expect(await store.get('alpha', stored.sha256)).toEqual(Buffer.from('reindex target'))
  })

  it('serves put/get over authenticated HTTP, refusing every request without the token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-store-test-'))
    const store = new DirectoryObjectStore(join(root, 'objects'))
    const http = new ObjectStoreHttp(store, 'replica-token-1')
    const port = await http.listen(0)
    const authorized = { authorization: 'Bearer replica-token-1' }

    // No token, wrong token: refused before the store is touched.
    const anonymous = await fetch(`http://127.0.0.1:${port}/alpha`, { method: 'PUT', body: Buffer.from('nope') })
    expect(anonymous.status).toBe(401)
    const wrongToken = await fetch(`http://127.0.0.1:${port}/alpha`, { method: 'PUT', headers: { authorization: 'Bearer replica-token-2' }, body: Buffer.from('nope') })
    expect(wrongToken.status).toBe(401)
    expect(await store.consistencyCheck('alpha')).toMatchObject({ ok: true, objects: 0 })

    const payload = Buffer.from('over the wire')
    const put = await fetch(`http://127.0.0.1:${port}/alpha`, { method: 'PUT', headers: authorized, body: payload })
    expect(put.status).toBe(201)
    const stored = (await put.json()) as { sha256: string }

    const get = await fetch(`http://127.0.0.1:${port}/alpha/${stored.sha256}`, { headers: authorized })
    expect(get.status).toBe(200)
    expect(Buffer.from(await get.arrayBuffer())).toEqual(payload)

    const foreign = await fetch(`http://127.0.0.1:${port}/beta/${stored.sha256}`, { headers: authorized })
    expect(foreign.status).toBe(400)
    await http.close()
  })

  it('passes a load run: put+get+verify within the latency budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-store-test-'))
    const store = new DirectoryObjectStore(join(root, 'objects'))
    const report = await objectStoreLoadRun(store, 'load-tenant', { operations: 40, seed: 42, maxLatencyMs: 2000, payloadBytes: 2048 })
    expect(report.ok).toBe(true)
    expect(report.failures).toHaveLength(0)
    expect(report.throughputOpsPerSecond).toBeGreaterThan(0)
  })
})
