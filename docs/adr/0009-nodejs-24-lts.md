# ADR-0009: Node.js 24 LTS

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** PR #39, `.nvmrc`

## Context

v1 runs on Node.js 20, which reached end-of-life in April 2026 and no longer receives security
fixes. The `bcrypt` 5 dependency also pulled in packages with known critical and high
advisories (`tar`, `brace-expansion`) through its binary download tool.

## Decision

1. **v2 runs on Node.js 24 LTS**, pinned in `.nvmrc` (`24`) and `package.json`
   (`"engines": { "node": ">=24 <25" }`). The Docker image is `node:24-alpine`.
2. Developers use **nvm-windows** (or nvm) to switch per branch: `main` uses 24,
   `release/1.x` uses 20.
3. `bcrypt` is upgraded to **6**, which ships its binaries inside the package. This removes
   the vulnerable install-time dependencies. Existing bcrypt 5 password hashes remain valid.
4. The project moves to the next LTS line during the support window of the current one, as a
   dedicated PR.

## Consequences

**Positive**
- Security fixes and support for the runtime throughout v2.
- Two security advisories removed (36 fewer packages).

**Negative / costs**
- Developers must manage two Node versions while v1 is maintained.

## Alternatives considered

- **Stay on Node.js 20:** unsupported, so no security fixes.
- **Node.js 22:** supported until April 2027 only; 24 gives a longer runway.
