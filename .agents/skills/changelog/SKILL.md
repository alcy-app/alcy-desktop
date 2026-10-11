---
name: changelog
description: Writes or updates entries in Alcy's CHANGELOG.md in plain language, focused on the feature and without excessive detail. Use when recording a version's changes, preparing a release or when asked to create, review or simplify the changelog.
---

# Alcy changelog

`CHANGELOG.md` is read by the people who **use** the app. It answers one question: *what changed for me in this version?* It is not technical documentation, a task list or a manual.

## Rules

1. **Plain, direct language.** Short sentences, in English, in the voice of someone who uses the app. No internal jargon (names of crates, components, commands, specs, ADRs, files).
2. **No excessive detail.** No sub-lists of options, numeric limits, secondary shortcuts, edge states or default values, unless they are the change itself (e.g. "the default timeout goes from 30 to 60 seconds").
3. **Focus on the feature.** Say *what* the person can do now and *what it is for*, not *how* it was implemented or every button on the screen.
4. **One feature = one item.** At most two sentences per item. If it needs a sub-list, the item is too detailed.
5. **Bold names only for new, large features** (e.g. **Collection runner**). Small improvements stay in plain text.
6. **Do not state the obvious.** Do not list translations, tests, refactors, style tweaks or documentation. Only changes the person notices go in.

## Format

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), already used in the file:

```markdown
## [X.Y.Z] - Unreleased

### Added

- **Feature name**: what it does, in one sentence. A second sentence only if it helps to understand the value.

### Changed

- What now works differently.

### Fixed

- The problem the person saw that no longer happens.
```

- Use only the sections that have items: **Added**, **Changed**, **Fixed**, **Removed**, **Deprecated**, **Security**.
- The version in progress stays as `Unreleased`. At release time, replace it with the version and the date (`## [X.Y.Z] - YYYY-MM-DD`).
- Do not change versions already published unless asked.

## How to do it

1. Read the top of `CHANGELOG.md` to find the version in progress and what is already recorded.
2. Gather what changed since the last version (`git log` since the previous version's commit and the user's request).
3. Group by perceived feature, not by commit. Several commits about the same feature become a single item.
4. Write each item following the rules above and reread it, cutting everything that is detail.
5. Show the result to the user. Do not commit unless asked.

## Examples

**Too detailed (avoid):**

```markdown
- **Collection runner**: runs the REST and GraphQL requests of a collection or folder in sequence.
  - Adjustable run order: drag to reorder and uncheck what should not run.
  - Options:
    - delay between requests;
    - stop on the first error;
    - treat HTTP 4xx/5xx as failure;
  - Live results: metrics, progress, filters by result and by iteration...
```

**Good:**

```markdown
- **Collection runner**: runs the requests of a collection or folder in batch.
```

**Too technical (avoid):**

```markdown
- `SharedHttpClient` now rebuilds the reqwest client under the same lock when the timeout or the proxy plan changes.
```

**Good:**

```markdown
- Changing the proxy no longer resets the configured timeout.
```

## Checklist before delivering

- [ ] Each item fits in up to two sentences, with no sub-lists.
- [ ] No internal name of code, file, spec or ADR.
- [ ] No number, option or shortcut that is not the change itself.
- [ ] Someone who did not follow the development understands what changed.
