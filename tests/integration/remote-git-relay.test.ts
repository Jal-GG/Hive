import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBundleFor, GitSmartRelay } from '../../src/remote/git-relay.js'
import { GitRunner, gitIdentityArgs } from '../../src/git.js'

/** One bare target plus one source repo with commits, the relay between them. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hive-relay-test-'))
  mkdirSync(join(root, 'target.git'), { recursive: true })
  mkdirSync(join(root, 'source'), { recursive: true })
  const target = new GitRunner(join(root, 'target.git'))
  target.run(['init', '--bare', '--quiet', '--initial-branch=main'])
  const source = new GitRunner(join(root, 'source'))
  source.run(['init', '--quiet', '--initial-branch=main'])
  source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'base'])
  return { root, target, source }
}

describe('remote Git smart relay', () => {
  it('creates an authorized branch from a self-contained bundle', async () => {
    const { root, source, target } = setup()
    source.run(['checkout', '-b', 'worker/one'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'work one'])
    const relay = new GitSmartRelay({ repositoryRoot: target.cwd, allowedBranches: ['worker/*'] })

    const bundle = createBundleFor(source.cwd, 'worker/one', undefined, '')
    const landed = await relay.push({ branch: 'worker/one', expectedHead: undefined, bundle })
    expect(landed).toMatchObject({ branch: 'worker/one', created: true })
    expect(target.run(['rev-parse', `refs/heads/worker/one`])).toBe(landed.head)
    void root
  })

  it('refuses a branch outside the allowlist before touching the repository', async () => {
    const { source, target } = setup()
    source.run(['checkout', '-b', 'main-guest'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'not allowed'])
    const relay = new GitSmartRelay({ repositoryRoot: target.cwd, allowedBranches: ['worker/*'] })

    const bundle = createBundleFor(source.cwd, 'main-guest', undefined, '')
    const refusal = relay.authorizePush('main-guest')
    expect(refusal.ok).toBe(false)
    await expect(relay.push({ branch: 'main-guest', expectedHead: undefined, bundle })).rejects.toThrow(/not in this relay's allowlist/)
    // And the ref still does not exist afterwards.
    expect(target.tryRun(['rev-parse', '--verify', 'refs/heads/main-guest'])).toBeUndefined()
  })

  it('fast-forwards with expected-head and refuses a stale CAS push', async () => {
    const { root, source, target } = setup()
    const relay = new GitSmartRelay({ repositoryRoot: target.cwd, allowedBranches: ['worker/*'] })
    source.run(['checkout', '-b', 'worker/cas'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'v1'])
    const first = createBundleFor(source.cwd, 'worker/cas', undefined, '')
    await relay.push({ branch: 'worker/cas', expectedHead: undefined, bundle: first })
    const head = target.run(['rev-parse', 'refs/heads/worker/cas'])

    // A second commit, pushed against the head we just observed.
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'v2'])
    const second = createBundleFor(source.cwd, 'worker/cas', head, '')
    await relay.push({ branch: 'worker/cas', expectedHead: head, bundle: second })
    const moved = target.run(['rev-parse', 'refs/heads/worker/cas'])
    expect(moved).not.toBe(head)

    // A stale push against the old head is refused, and the branch is unmoved.
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'v3'])
    const stale = createBundleFor(source.cwd, 'worker/cas', head, '')
    await expect(relay.push({ branch: 'worker/cas', expectedHead: head, bundle: stale })).rejects.toThrow(/moved|prerequisites/)
    expect(target.run(['rev-parse', 'refs/heads/worker/cas'])).toBe(moved)
    void root
  })

  it('fetches a bundle whose content matches the head it claims', async () => {
    const { root, source, target } = setup()
    const relay = new GitSmartRelay({ repositoryRoot: target.cwd, allowedBranches: ['worker/*'] })
    source.run(['checkout', '-b', 'worker/fetchable'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'fetchable'])
    await relay.push({ branch: 'worker/fetchable', expectedHead: undefined, bundle: createBundleFor(source.cwd, 'worker/fetchable', undefined, '') })

    const fetched = await relay.fetch('worker/fetchable')
    expect(fetched.head).toBe(target.run(['rev-parse', 'refs/heads/worker/fetchable']))
    // The fetched bundle actually un-bundles into a fresh clone: bytes on the wire are real.
    const consumerPath = join(root, 'consumer')
    mkdirSync(consumerPath, { recursive: true })
    const consumer = new GitRunner(consumerPath)
    consumer.run(['init', '--quiet', '--initial-branch=main'])
    consumer.run(['fetch', '--quiet', writeTempBundle(root, fetched.bundle), 'refs/heads/worker/fetchable:refs/heads/worker/fetchable'])
    expect(consumer.run(['rev-parse', 'refs/heads/worker/fetchable'])).toBe(fetched.head)
  })

  it('refuses a bundle that carries a different branch than it claims', async () => {
    const { source, target } = setup()
    const relay = new GitSmartRelay({ repositoryRoot: target.cwd, allowedBranches: ['worker/*'] })
    source.run(['checkout', '-b', 'worker/a'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'a'])
    source.run(['checkout', '-b', 'worker/b'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'b'])
    const bundle = createBundleFor(source.cwd, 'worker/b', undefined, '')
    await expect(relay.push({ branch: 'worker/a', expectedHead: undefined, bundle })).rejects.toThrow(/does not carry refs\/heads\/worker\/a/)
  })

  it('refuses an oversized bundle before touching the repository', async () => {
    const { source, target } = setup()
    const relay = new GitSmartRelay({ repositoryRoot: target.cwd, allowedBranches: ['worker/*'], maxBundleBytes: 8 })
    source.run(['checkout', '-b', 'worker/big'])
    source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'big'])
    const bundle = createBundleFor(source.cwd, 'worker/big', undefined, '')
    expect(bundle.length).toBeGreaterThan(8)
    await expect(relay.push({ branch: 'worker/big', expectedHead: undefined, bundle })).rejects.toThrow(/exceeds this relay's/)
    expect(target.tryRun(['rev-parse', '--verify', 'refs/heads/worker/big'])).toBeUndefined()
  })
})

function writeTempBundle(root: string, bundle: Buffer): string {
  const directory = mkdtempSync(join(root, 'fetch-'))
  const path = join(directory, 'fetched.bundle')
  writeFileSync(path, bundle)
  return path
}
