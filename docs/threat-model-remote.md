# Hive Remote Plane — Threat Model (§7 Phase 9)

Scope: the surfaces Phase 9 adds — the mTLS `ExecutionAgent`, the Git smart
relay, the remote object store, federation import, deployment profiles, and the
health endpoints. Local-only surfaces are covered by the phase 1–8 capability
model and are unchanged by this phase.

## Assets

1. **Target repositories** — the bare repos the relay lands refs into.
2. **The control ledger** — coordination authority; remote clients must never reach it directly.
3. **Context objects** — tenant-scoped content in the object store.
4. **The event log** — the audit trail federation exports pages of.
5. **The CA private key** — the trust anchor for every remote identity.

## Trust boundaries

| Boundary | Crossing | Control |
|---|---|---|
| Network → Agent | TLS session | Mutual certificate authentication; CA-pinned; fail-closed verification with named reasons (`certs.ts`); untrusted client certs are rejected at the TLS layer (`rejectUnauthorized: true`), with a server-side identity check as defense in depth |
| Client identity → Authority | Leaf CN | Any CA-issued leaf may connect; deployments restrict further with the policy's optional `allowedClientIdentities` allowlist — client and server identities are separate concerns |
| Client ask → Agent action | `request` frame | Capability + command must both be in the policy allowlist; typed dispatch, no generic path (`protocol.ts`, `agent.ts`) |
| Bundle → Target repo | `git.push` | Branch allowlist *before* parse; `git bundle verify` prerequisites (CAS); fetch into a namespaced ref, then `update-ref <ref> <new> <old>` — a ref-level compare-and-swap, atomic against concurrent writers (`git-relay.ts`) |
| Object bytes → Store | `store.put`/`get` | Content addressing; tenant namespace is part of the address; every read re-verifies the hash; HTTP PUT bodies are capped at 32 MiB before buffering; the HTTP face requires a bearer token on every request (`object-store.ts`) |
| Peer export → Local ledger | `importPage` | Checksum, sovereignty, event-type contract, and conflict-policy checks, then quarantine rows only — never direct adoption; re-import of a held page is idempotent, a page that skips the persisted replay cursor is refused as a gap, and a peer whose manifest changes mid-stream is refused (`federation.ts`); imports and promote/reject decisions require the `federation:review` capability and are written to `audit_log` |
| Release bits → Host | `verifyRelease` | SHA256SUMS.json manifest, producer- and consumer-side (`drills.ts`) |

## Threats and mitigations

| ID | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Stolen agent leaf certificate | Leaf carries `CA:FALSE`; revocation is rotation of the CA (offline key); short leaf validity is configurable | Detection lag until rotation |
| T2 | Valid cert, untrusted client identity | Any leaf the CA issued may connect; deployments that need per-client restrictions set `allowedClientIdentities`, and a CN outside it is destroyed, not served | Deployments relying on CA-only trust accept every issued leaf by design |
| T3 | Command injection through a request | Commands are a closed enum dispatched by name; arguments are validated per-command; no shell, no `exec` | None known |
| T4 | Push to an unauthorized branch | Policy allowlist checked in `agent.dispatch` **and** in `relay.authorizePush`; empty allowlist refuses all | Operator misconfiguration (allowlist too broad) |
| T5 | Non-fast-forward or stale push racing a moved branch | CAS on `expectedHead`; `git bundle verify` enforces prerequisites; the ref update is the three-arg `update-ref <ref> <new> <old>` form — a ref-level compare-and-swap, atomic against concurrent writers | Concurrent pushes serialize through ref updates; a race loses to the CAS refusal |
| T6 | Cross-tenant object access | Address is `tenant/sha`; `get` refuses a tenant that does not own the bytes | None known |
| T7 | Corrupt or tampered store content | Hash is the address; reads verify; `consistencyCheck` walks the tenant | Slow corruption discovered only at read/check time |
| T8 | Malicious federation export | Whole-page refusal on checksum, sovereignty, contract, or unimplemented-conflict-policy violation; events land in quarantine for operator review; re-import is idempotent and replay-gapped pages are refused | Operator promotes a malicious record (explicit action, audited in `audit_log`) |
| T9 | Replay of a captured request | Request IDs are idempotent for a bounded LRU window — replay returns the first reply, not a second execution | Window expiry after 256 distinct requests |
| T10 | DoS via oversized frames, bodies, or bundles | 1 MiB frame cap in the decoder before JSON parse; 32 MiB HTTP PUT body cap before buffering; 64 MiB relay bundle cap before disk; in-flight requests beyond the agent's concurrency limit are refused with `TOO_BUSY` rather than queued | Many small frames (no rate limit yet — deployment-level concern) |
| T11 | Ledger data exfiltration via events | Only manifest-declared event types export; payload keys matching secret/token/key/password/credential patterns are dropped by scrubbing | Residual fields in payloads (names, titles) — declared as scrubbing's limit |
| T12 | Downgrade / version skew | Protocol version is exact-match at hello; mismatch is fatal | Old client + old server both speak v1 forever — acceptable, versions are explicit |
| T13 | Compromised release artifact | SHA256SUMS.json producer-side and consumer-side verification | Signing (rather than hashing) is future work; hash manifest is the v1 bar |
| T14 | CA key compromise | Key is operator-held and offline by construction; compromise requires re-issuing every leaf | Total re-trust is manual by design |
| T15 | Unauthorized federation review or unaudited recovery decisions | `federate import/promote/reject` require the `federation:review` capability; imports, promote/reject, and CLI drill runs write to `audit_log` with the deciding actor | An operator holding the capability makes a bad decision — auditable, not preventable |
| T16 | A restore that saves the ledger but loses context | The remote restore drill bundles the Git-backed context filesystem with the event export and fails unless both digests match (`drills.ts`) | Context roots with no commits are refused, not silently skipped |

## What this plane deliberately does not expose

- No shell, no `git-upload-pack`/`receive-pack` service, no path-bearing commands.
- No anonymous mode: the dashboard/health endpoints are loopback and read-only.
- No direct ledger access: remote clients see events through the agent's page
  command, and federation peers see scrubbed pages in quarantine.
- No automatic promotion of imported records, and no cross-town writes (§8).

## Review cadence

This model is reviewed when: a new command joins the agent's dispatch, the
frame format changes, the store layout changes, or a deployment profile adds a
new network listener. Each review must re-walk the boundary table above and
update the threat list — a threat model that ships once and never changes is
documentation of a system that no longer exists.
