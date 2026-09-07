# Hive: Unified Agent Harness

Hive is a local-first platform that launches real coding-agent CLIs in isolated Git worktrees, coordinates their identities, tasks, handoffs, mail, convoys, merge queues, and recovery, and gives every agent a durable context system.

---

## 🏛️ System Architecture

Below is the high-level architecture diagram for the Hive platform, showing the interaction between the **Command & Gateway Layer**, **Control Ledger & Event Bus**, **Work Plane**, **Execution & Runtime Plane**, and **Context & Memory System**:

```html
<!-- Interactive / visual architecture diagram source: architecture.html -->
```

> 💡 **Visual Architecture Diagram**: For an interactive and visual view of the architecture, see [architecture.html](architecture.html).

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                     COMMAND & GATEWAY LAYER                             │
 │  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐  │
 │  │ Electron Desktop│    │ CLI / API / MCP  │    │ Integrations /     │  │
 │  │ Control Console │    │ Controller Surface│   │ External Triggers  │  │
 │  └────────┬────────┘    └────────┬─────────┘    └────────┬───────────┘  │
 └───────────┼──────────────────────┼───────────────────────┼──────────────┘
             │                      │                       │
 ┌───────────▼──────────────────────▼───────────────────────▼──────────────┐
 │                     CONTROL LEDGER & EVENT BUS                          │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │ Transactional Issue Ledger & Event Bus (Dolt / SQLite / Events)   │  │
 │  │ Leases • State Transitions • Idempotency • Audit Log • Invalidation│  │
 │  └───────────────────────────────┬───────────────────────────────────┘  │
 └──────────────────────────────────┼──────────────────────────────────────┘
                                    │
 ┌──────────────────────────────────┴──────────────────────────────────────┐
 │                              WORK PLANE                                 │
 │  ┌────────────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
 │  │ Task & Convoy Dispatch  │  │ Agent Mail &    │  │ Verified Merge   │  │
 │  │ & Capacity Scheduler   │  │ Handoff Router  │  │ Queue & Gates    │  │
 │  └────────┬───────────────┘  └────────┬────────┘  └────────┬─────────┘  │
 └───────────┼───────────────────────────┼────────────────────┼────────────┘
             │                           │                    │
 ┌───────────▼───────────────────────────▼────────────────────▼────────────┐
 │                     EXECUTION & RUNTIME PLANE                           │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │ Worker Supervisor & PTY Runtime                                   │  │
 │  │ Git Worktree Isolation • Lifecycle Hooks • Circuit Breakers       │  │
 │  └───────────────────────────────┬───────────────────────────────────┘  │
 └──────────────────────────────────┼──────────────────────────────────────┘
                                    │
 ┌──────────────────────────────────▼──────────────────────────────────────┐
 │                      CONTEXT & MEMORY PLANE                             │
 │  ┌──────────────────┐    ┌─────────────────┐    ┌────────────────────┐  │
 │  │ Canonical Context│    │ Derived Indexes │    │ Skills Catalog &   │  │
 │  │ Markdown System  │    │ Vector / FTS    │    │ Async Ingest Queue │  │
 │  └──────────────────┘    └─────────────────┘    └────────────────────┘  │
 └─────────────────────────────────────────────────────────────────────────┘
```

---

## 📖 Specifications & Documentation

- [architecture.html](architecture.html) — Standalone HTML/SVG architecture diagram.
