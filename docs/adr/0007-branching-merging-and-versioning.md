# ADR-0007: Branching, merging, versioning and release ownership

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** `CLAUDE.md` (collaboration rules), tracker #37

## Context

v1 is in use by customers, and v2 is a long refactor of the same codebase. The owner wants a
clean, professional history in which every commit is authored by the owner, while an AI
assistant does much of the implementation.

## Decision

1. **Branches**
   - `main` is the v2 line.
   - `release/1.x` maintains v1. It receives only fixes, released as `v1.1.x`.
   - Work happens on short-lived branches and reaches `main` only through pull requests.
2. **Merging (owner only, in the GitHub web UI)**
   - Feature PRs into `main`: **Squash and merge**. Each PR becomes one GitHub-signed,
     Verified commit with one clean message.
   - `release/1.x` into `main`: **Create a merge commit**, so a fix keeps the same commit ID
     on both branches.
   - History on `main` and `release/1.x` is never rewritten without the owner's explicit
     permission.
3. **Authorship**
   - All commits are authored as `King2H <neg2htt@gmail.com>`.
   - No AI attribution (`Co-Authored-By`, session links) in commits or PR descriptions.
   - The owner's local commits are signed with an SSH key.
   - The AI assistant commits or pushes only when the owner explicitly asks.
4. **Versioning:** Semantic Versioning (`MAJOR.MINOR.PATCH`).
   - The v2 release is **`v2.0.0`**.
   - Pre-release tags (`v2.0.0-alpha.N`, `-beta.N`, `-rc.N`) are created **only when a build
     is handed to someone outside development** (pilot customer, testers). Otherwise the
     project goes straight to `v2.0.0`.
   - Planning uses GitHub Milestones.
5. **Releases:** the owner creates tags and publishes GitHub releases.
6. **Pull requests:** small, one issue each (`Closes #N`), with what changed and how it was
   verified.

## Consequences

**Positive**
- `main` reads as one meaningful commit per change, all Verified and authored by the owner.
- v1 customers can receive fixes without waiting for v2.
- A `v2.0.0` tag is only published when the release is really final.

**Negative / costs**
- Squash merging loses the individual working commits of a PR (they remain visible in the
  closed PR).
- Fixes needed on both lines go to `release/1.x` first and are then merged into `main`.

## Alternatives considered

- **A long-lived `v2` branch merged into `main` at the end:** it would drift and end in one
  large, risky merge.
- **Rebase-and-merge:** creates copies with new IDs and removes GitHub's signature.
- **Always publishing pre-release tags:** extra ceremony when nobody outside development is
  testing.
