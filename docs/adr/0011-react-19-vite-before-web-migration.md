# ADR-0011: React 19, current Vite and React Router before the web migration

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H (delegated the technical choice to the implementer)
- **Related:** issue #23, ADR-0001, ADR-0004

## Context

The web app uses React 18 and Vite 5, with navigation held in a `useState` in `App.tsx`: no
URLs, no back button, no deep links. v2 moves every screen to a feature-folder structure with
a typed API client (#23). Upgrading the framework after that migration would mean touching
every screen twice.

## Decision

1. As the **first step of the web work**, before any feature is migrated, one dedicated PR:
   - upgrades to **React 19**;
   - upgrades to the **current Vite major**, with matching versions of Vitest, Testing Library
     and the React plugin;
   - introduces **React Router** for navigation.
2. The existing web tests must pass after the upgrade, with no change in behaviour.
3. Features are then migrated one per PR on the new versions.

## Consequences

**Positive**
- Each screen is reworked once, directly on current, supported versions.
- Real URLs, back-button support and deep links for every page.

**Negative / costs**
- A larger first PR in the web work, with some breaking-change fixes from the upgrades.

## Alternatives considered

- **Stay on React 18 / Vite 5:** works today, but falls behind the supported versions during
  v2.
- **Upgrade after the feature migration:** every screen would be touched twice.
- **A different framework (e.g. Next.js):** server rendering is not needed for an internal
  ERP and would add hosting complexity, especially on-premise.
