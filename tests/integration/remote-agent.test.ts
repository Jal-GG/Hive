import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CertificateAuthority, generateCA } from '../../src/remote/certs.js'
import { ExecutionAgent, RemoteAgentClient } from '../../src/remote/agent.js'
import { FrameDecoder, encodeFrame, type Frame, type RemotePolicy } from '../../src/remote/protocol.js'
import { DirectoryObjectStore } from '../../src/remote/object-store.js'
import { createBundleFor, GitSmartRelay } from '../../src/remote/git-relay.js'
import { GitRunner, gitIdentityArgs } from '../../src/git.js'
import { ledgerWithActors, testActor } from '../fixtures.js'
import { runRemoteCli } from '../../src/interfaces/cli/remote-cli.js'
import { requestLoadRun } from '../../src/remote/load.js'
import type { Capability } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read']

const caBundle = generateCA()
const authority = CertificateAuthority.fromPem(caBundle.certificate, caBundle.privateKey)
// The agent's own TLS identity, with an IP SAN for the loopback listener.
const agentLeaf = authority.issue({ id: 'agent-1', ips: ['127.0.0.1'] })
const clientLeaf = authority.issue({ id: 'operator-1' })

function policy(): RemotePolicy {
  return {
    identity: 'agent-1',
    capabilities: ['ping', 'events', 'store.put', 'store.get', 'git.fetch', 'git.head', 'git.push'],
    commands: {
      ping: ['ping'], events: ['events'], 'store.put': ['store.put'], 'store.get': ['store.get'],
      'git.fetch': ['git.fetch'], 'git.head': ['git.head'], 'git.push': ['git.push'],
    },
    allowedBranches: ['worker/*'],
  }
}

/** A full agent stack on an ephemeral port: relay over a bare repo, store over a temp directory. */
async function agentStack() {
  const root = mkdtempSync(join(tmpdir(), 'hive-agent-test-'))
  mkdirSync(join(root, 'target.git'), { recursive: true })
  const bare = new GitRunner(join(root, 'target.git'))
  bare.run(['init', '--bare', '--quiet', '--initial-branch=main'])
  const relay = new GitSmartRelay({ repositoryRoot: join(root, 'target.git'), allowedBranches: ['worker/*'] })
  const store = new DirectoryObjectStore(join(root, 'store'))
  const actor = testActor('operator', capabilities)
  const ledger = ledgerWithActors(actor)
  const agent = new ExecutionAgent({
    policy: policy(),
    authority,
    serverCertificate: { certificate: agentLeaf.certificate, privateKey: agentLeaf.privateKey },
    relay,
    store,
    events: (after, limit) => ({ events: ledger.readEvents(after, limit), latest: ledger.latestEventSequence() }),
  })
  const port = await agent.listen(0)
  return { agent, port, root, ledger, relay, close: async () => { await agent.close(); ledger.close() } }
}

function client(port: number): RemoteAgentClient {
  return new RemoteAgentClient({
    host: '127.0.0.1',
    port,
    certificate: clientLeaf.certificate,
    privateKey: clientLeaf.privateKey,
    serverAuthority: caBundle.certificate,
  })
}

function readLeaf(stateRoot: string, identity: string, file: string): string {
  return readFileSync(join(stateRoot, 'remote', 'leaves', identity, file), 'utf8')
}

describe('remote ExecutionAgent', () => {
  it('negotiates hello/welcome, answers ping, and refuses a command outside the policy', async () => {
    const stack = await agentStack()
    try {
      const connection = await client(stack.port).connect()
      expect(connection.identity).toBe('agent-1')
      expect(connection.protocolVersion).toBe(1)

      const c = client(stack.port)
      await c.connect()
      const pong = await c.request('ping', 'ping')
      expect(pong.ok).toBe(true)
      if (pong.ok) expect(pong.data).toMatchObject({ pong: true, identity: 'agent-1' })

      // A command not in the allowlist is a policy refusal, not an error — and
      // the refusal is a reply, so the connection stays usable.
      const refused = await c.request('shell', 'exec', { command: 'rm -rf /' })
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error?.code).toBe('POLICY_REFUSED')
      const stillAlive = await c.request('ping', 'ping')
      expect(stillAlive.ok).toBe(true)
      c.close()
    } finally {
      await stack.close()
    }
  })

  it('rejects a client whose certificate is not from this CA', async () => {
    const stack = await agentStack()
    try {
      const strangerCa = generateCA()
      const strangerLeaf = CertificateAuthority.fromPem(strangerCa.certificate, strangerCa.privateKey).issue({ id: 'agent-1' })
      const c = new RemoteAgentClient({
        host: '127.0.0.1', port: stack.port,
        certificate: strangerLeaf.certificate, privateKey: strangerLeaf.privateKey,
        serverAuthority: caBundle.certificate,
      })
      await expect(c.connect()).rejects.toThrow()
    } finally {
      await stack.close()
    }
  })

  it('returns the remembered reply for a retried request ID, without re-executing', async () => {
    const stack = await agentStack()
    try {
      // A counting relay makes re-execution observable: each push increments.
      let pushes = 0
      const countingRelay = {
        push: async (request: { branch: string; expectedHead?: string; bundle: Buffer }) => {
          pushes += 1
          return stack.relay.push(request)
        },
        fetch: (branch: string) => stack.relay.fetch(branch),
        headOf: (branch: string) => stack.relay.headOf(branch),
      }
      // A source repo with one commit on a worker branch, bundled for the relay.
      mkdirSync(join(stack.root, 'source'), { recursive: true })
      const source = new GitRunner(join(stack.root, 'source'))
      source.run(['init', '--quiet', '--initial-branch=main'])
      source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'base'])
      source.run(['checkout', '-b', 'worker/retry'])
      source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'work'])
      const bundle = createBundleFor(source.cwd, 'worker/retry', undefined, '')

      const countingAgent = new ExecutionAgent({
        policy: policy(),
        authority,
        serverCertificate: { certificate: agentLeaf.certificate, privateKey: agentLeaf.privateKey },
        relay: countingRelay,
        store: new DirectoryObjectStore(join(stack.root, 'store2')),
        events: () => ({ events: [], latest: 0 }),
      })
      const port = await countingAgent.listen(0)
      try {
        const c = client(port)
        await c.connect()
        const args = { branch: 'worker/retry', bundle: bundle.toString('base64') }
        const first = await c.requestWithId('retry-1', 'git.push', 'git.push', args)
        expect(first.ok).toBe(true)
        // The retry: same ID, same arguments. The remembered reply comes back
        // and the relay never runs a second time.
        const retry = await c.requestWithId('retry-1', 'git.push', 'git.push', args)
        expect(retry.ok).toBe(first.ok)
        expect(retry.data).toEqual(first.data)
        expect(pushes).toBe(1)
        c.close()
      } finally {
        await countingAgent.close()
      }
    } finally {
      await stack.close()
    }
  })

  it('serves store.put/get with verification, and git.head for a missing branch as null', async () => {
    const stack = await agentStack()
    try {
      const c = client(stack.port)
      await c.connect()
      const stored = await c.request('store.put', 'store.put', { tenant: 'alpha', bytes: Buffer.from('tenant content').toString('base64') })
      expect(stored.ok).toBe(true)
      const sha256 = (stored.data as { sha256: string }).sha256
      const fetched = await c.request('store.get', 'store.get', { tenant: 'alpha', sha256 })
      expect(fetched.ok).toBe(true)
      if (fetched.ok) expect(Buffer.from((fetched.data as { bytes: string }).bytes, 'base64').toString()).toBe('tenant content')

      const missing = await c.request('store.get', 'store.get', { tenant: 'beta', sha256 })
      expect(missing.ok).toBe(false)

      const head = await c.request('git.head', 'git.head', { branch: 'worker/none' })
      expect(head.ok).toBe(true)
      if (head.ok) expect(head.data).toEqual({ head: null })
      c.close()
    } finally {
      await stack.close()
    }
  })

  it('pushes and pulls through the CLI by dialing the agent over mTLS', { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-cli-dial-'))
    const actor = testActor('operator', capabilities)
    const ledger = ledgerWithActors(actor)
    try {
      // The state root a deployment would have: CA, an agent leaf, a client leaf.
      const stateRoot = join(root, 'state')
      const caDirectory = join(stateRoot, 'remote', 'ca')
      mkdirSync(caDirectory, { recursive: true })
      const ca = generateCA()
      writeFileSync(join(caDirectory, 'ca.crt'), ca.certificate, 'utf8')
      writeFileSync(join(caDirectory, 'ca.key'), ca.privateKey, 'utf8')
      const authority = CertificateAuthority.fromPem(ca.certificate, ca.privateKey)
      for (const identity of ['agent-1', 'operator-1']) {
        const leafDirectory = join(stateRoot, 'remote', 'leaves', identity)
        mkdirSync(leafDirectory, { recursive: true })
        const leaf = authority.issue({ id: identity, ips: ['127.0.0.1'] })
        writeFileSync(join(leafDirectory, 'agent.crt'), leaf.certificate, 'utf8')
        writeFileSync(join(leafDirectory, 'agent.key'), leaf.privateKey, 'utf8')
        writeFileSync(join(leafDirectory, 'client.crt'), leaf.certificate, 'utf8')
        writeFileSync(join(leafDirectory, 'client.key'), leaf.privateKey, 'utf8')
      }

      // A bare target the agent's relay owns, and a source repo with a worker branch.
      mkdirSync(join(root, 'target.git'), { recursive: true })
      const bare = new GitRunner(join(root, 'target.git'))
      bare.run(['init', '--bare', '--quiet', '--initial-branch=main'])
      mkdirSync(join(root, 'source'), { recursive: true })
      const source = new GitRunner(join(root, 'source'))
      source.run(['init', '--quiet', '--initial-branch=main'])
      source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'base'])
      source.run(['checkout', '-b', 'worker/cli'])
      writeFileSync(join(root, 'source', 'work.txt'), 'from the CLI\n', 'utf8')
      source.run(['add', '--all'])
      source.run([...gitIdentityArgs, 'commit', '--quiet', '-m', 'cli work'])

      const agent = new ExecutionAgent({
        policy: policy(),
        authority,
        serverCertificate: {
          certificate: readLeaf(stateRoot, 'agent-1', 'agent.crt'),
          privateKey: readLeaf(stateRoot, 'agent-1', 'agent.key'),
        },
        relay: new GitSmartRelay({ repositoryRoot: join(root, 'target.git'), allowedBranches: ['worker/*'] }),
        store: new DirectoryObjectStore(join(root, 'store')),
        events: () => ({ events: [], latest: 0 }),
      })
      const port = await agent.listen(0)
      try {
        const scope = { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }
        const options = { ledger, scope, stateRoot, packageRoot: root }

        // The dial path: `hive remote push --port` goes through the agent, not a local repo.
        const pushed = JSON.parse(await runRemoteCli(options, actor, ['push', '--repo', join(root, 'source'), '--branch', 'worker/cli', '--port', String(port)])) as { branch: string; head: string }
        expect(pushed.branch).toBe('worker/cli')
        expect(pushed.head).toBe(bare.run(['rev-parse', 'refs/heads/worker/cli']))

        // And the pull side, from the same agent.
        const pulled = JSON.parse(await runRemoteCli(options, actor, ['pull', '--branch', 'worker/cli', '--port', String(port)])) as { head: string; bundleBytes: number }
        expect(pulled.head).toBe(pushed.head)
        expect(pulled.bundleBytes).toBeGreaterThan(0)
      } finally {
        await agent.close()
      }
    } finally {
      ledger.close()
    }
  })

  it('passes a request load run against a live agent within the latency budget', { timeout: 30_000 }, async () => {
    const stack = await agentStack()
    try {
      const c = client(stack.port)
      await c.connect()
      const report = await requestLoadRun((index) => c.request('ping', 'ping', { n: index }), {
        operations: 30, seed: 7, maxLatencyMs: 2000, payloadBytes: 16,
      })
      expect(report.ok).toBe(true)
      expect(report.failures).toHaveLength(0)
      expect(report.throughputOpsPerSecond).toBeGreaterThan(0)
      c.close()
    } finally {
      await stack.close()
    }
  })

  it('refuses work beyond the concurrency limit with TOO_BUSY, and the retry succeeds once load drops', { timeout: 20_000 }, async () => {
    const stack = await agentStack()
    try {
      // A relay whose push takes a moment, so two requests genuinely overlap.
      let inFlight = 0
      let peak = 0
      const slowRelay = {
        push: async (request: { branch: string; expectedHead?: string; bundle: Buffer }) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 150))
          try {
            return await stack.relay.push(request)
          } finally {
            inFlight -= 1
          }
        },
        fetch: (branch: string) => stack.relay.fetch(branch),
        headOf: (branch: string) => stack.relay.headOf(branch),
      }
      mkdirSync(join(stack.root, 'source'), { recursive: true })
      const source = new GitRunner(join(stack.root, 'source'))
      source.run(['init', '--quiet', '--initial-branch=main'])
      source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'base'])
      source.run(['checkout', '-b', 'worker/busy'])
      source.run([...gitIdentityArgs, 'commit', '--allow-empty', '-m', 'work'])
      const bundle = createBundleFor(source.cwd, 'worker/busy', undefined, '')

      const agent = new ExecutionAgent({
        policy: policy(),
        authority,
        serverCertificate: { certificate: agentLeaf.certificate, privateKey: agentLeaf.privateKey },
        relay: slowRelay,
        store: new DirectoryObjectStore(join(stack.root, 'store3')),
        events: () => ({ events: [], latest: 0 }),
        maxConcurrentRequests: 1,
      })
      const port = await agent.listen(0)
      try {
        const c = client(port)
        await c.connect()
        const args = { branch: 'worker/busy', bundle: bundle.toString('base64') }
        const first = c.requestWithId('busy-1', 'git.push', 'git.push', args)
        await new Promise((resolve) => setTimeout(resolve, 30))
        const refused = await c.requestWithId('busy-2', 'git.push', 'git.push', args)
        expect(refused.ok).toBe(false)
        if (!refused.ok) expect(refused.error?.code).toBe('TOO_BUSY')
        const landed = await first
        expect(landed.ok).toBe(true)
        // The refused request never executed, and it was not remembered:
        // once the first completes, the retry lands for real.
        const retried = await c.requestWithId('busy-2', 'git.push', 'git.push', { ...args, branch: 'worker/busy' })
        // worker/busy now exists, so a create-push is stale — the retry answers
        // with the relay's honest refusal, proving it re-executed rather than
        // replaying the TOO_BUSY.
        expect(retried.ok).toBe(false)
        if (!retried.ok) expect(retried.error?.code).toBe('COMMAND_FAILED')
        expect(peak).toBe(1)
        c.close()
      } finally {
        await agent.close()
      }
    } finally {
      await stack.close()
    }
  })

  it('pins the expected agent identity: a welcome naming another agent fails the connect', async () => {
    const stack = await agentStack()
    try {
      const c = new RemoteAgentClient({
        host: '127.0.0.1',
        port: stack.port,
        certificate: clientLeaf.certificate,
        privateKey: clientLeaf.privateKey,
        serverAuthority: caBundle.certificate,
        expectedIdentity: 'agent-999',
      })
      await expect(c.connect()).rejects.toThrow(/answered as agent-1, expected agent-999/)
    } finally {
      await stack.close()
    }
  })

  it('decodes split and coalesced frames identically', () => {
    const frames: Frame[] = [
      { type: 'hello', protocolVersion: 1, capabilities: ['ping'] },
      { type: 'request', requestId: 'r1', capability: 'ping', command: 'ping', arguments: {} },
      { type: 'cancel', requestId: 'r1' },
    ]
    const wire = Buffer.concat(frames.map(encodeFrame))
    const whole = new FrameDecoder().feed(wire)
    expect(whole).toHaveLength(3)

    // The same bytes, delivered one byte at a time: segmentation cannot break framing.
    const piecewise = new FrameDecoder()
    const collected: Frame[] = []
    for (const byte of wire) collected.push(...piecewise.feed(Buffer.from([byte])))
    expect(collected).toHaveLength(3)
    expect(collected.map((frame) => frame.type)).toEqual(whole.map((frame) => frame.type))

    // An oversized frame header is refused before any body arrives.
    const hostile = Buffer.alloc(5)
    hostile.writeUInt8(3, 0)
    hostile.writeUInt32BE(2 * 1024 * 1024, 1)
    expect(() => new FrameDecoder().feed(hostile)).toThrow(/exceeds/)
  })
})
