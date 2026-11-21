# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the package uses
[Semantic Versioning](https://semver.org/) with the pre-1.0 rule that a breaking change or a change of
verdicts bumps the minor.

## [0.7.2] — 2026-11-21

First public release as `@hoshinotatsuya/deps-guard`, MIT; documentation in English and Russian; no
functional changes.

### Changed

- README examples live in `examples/` (`deps-guard.json` is validated by the package's config parser in
  the tests, the TypeScript files are type-checked against the package source by `pnpm run typecheck`).
- The consumer matrix installs with `--prefer-offline` instead of `--offline`, so it also runs on a fresh
  CI machine.
- CI runs on GitHub Actions; dev dependencies: arch-gates 0.12.2, jest-groups 0.7.2.

## [0.7.1] — 2026-11-21

### Fixed

- Failure and finding texts no longer throw on a value without a prototype or with a throwing `toString`
  (a YAML mapping, `{"toString": 1}` in JSON, an object from the caller): `check` used to throw instead of
  the `broken` verdict on unsupported `lockfileVersion` / `__metadata.version` shapes, pnpm
  `resolution.type` and names in `bannedPackages`; `new-dependency` crashed on such a dependency value,
  `source` lost the `checksumBehavior` violation, `freshness` lost "not verified"; the CLI lost the reason
  (`undefined`) and crashed on a thrown `null`.

## [0.7.0] — 2026-11-17

### Added

- Rule `banned-package`: `bannedPackages: [{ "name", "reason" }]` in `deps-guard.json` (type
  `BannedPackage`). Judges the lock-file tree — direct, transitive, manager-installed peers, optional,
  aliases, pnpm config dependencies — and names the chains from direct dependencies.
- Lock-file parsers record tree edges: `LockedPackage.dependencies`, `LockedDirect.target`,
  `LockedConfigDependency.target` (optional fields).
- Fixtures `fixtures/banned-package/<manager>/<case>` written by real npm 12.2.2, pnpm 12.21.0, yarn
  1.22.22 and yarn 4.18.1 from a fake registry.

### Changed

- yarn 1: a `dependencies`/`optionalDependencies` line that is not `name range` is "not read"; pnpm: such
  sections that are not a map of names to versions are "not read".

### Migration

The report has a ninth rule; `switch` handlers over `RuleId` must handle `banned-package`. Without
`bannedPackages` the rule is green with a sample of 0. The Jest gate gets a new `it`.

## [0.6.0] — 2026-11-17

Fixes from an external audit; verdicts change.

### Fixed

- npm: the target of a `file:`/`link:` dependency is no longer treated as a workspace project (only
  directories under the root's `workspaces` patterns are).
- pnpm 9.5+: `lock-mismatch` compares catalog ranges with the `catalogs` section of the lock file
  (`Lockfile.catalogs`, `LockedCatalogEntry`); a catalog changed without reinstalling is a violation.
- `https://…/x.git[#commit]` (yarn 1 `resolved`) is a git source with a commit, not a tarball.
- `deps-guard metadata`: credentials in a registry URL are neither used nor sent nor printed; a scoped
  tarball URL with `%2F` is inside the registry layout.
- `.yarnrc` with a BOM is read; `DepsGuard.check` with a broken `metadata` argument gives `broken` instead
  of throwing; `baseline --out` / `metadata --out` keep absolute paths and resolve relative ones from `--root`.

### Migration

Remove `newDependencies.allow` entries that existed only for dependencies of an npm `file:` target (they
become stale). Reinstall pnpm projects whose catalog entries the gate reports.

## [0.5.0] — 2026-11-17

### Added

- yarn.lock formats 9 and 10 (yarn 4.14–4.18; `Lockfile.berryFormat`); pnpm 12.11+ `permissions.<pkg>.build`;
  checks against npm 12.2.2, yarn 1.22.22 and pnpm 12.21.0 lock files (`fixtures/latest`).

### Changed

- yarn 4.14+: without `enableScripts`, the scripts of the rest are blocked by default; `exec:` follows
  the script setting. yarn 2+: a git dependency is an `install-script` violation even with
  `enableScripts: false` and `built: false` (yarn runs its `prepack` anyway). yarn 4.10+ `catalog:` support.
- pnpm `packageManagerDependencies` (pnpm itself) need no install-script decision
  (`LockedPackage.packageManager`).

### Migration

yarn 2+ projects on format 9/10 that used to get exit code 2 are now judged by every rule — set
`sources.registries` and git decisions (`installScripts.allow`). Remove `installScripts.allow` entries for
`pnpm` added for the former false finding.

## [0.4.0] — 2026-11-17

### Added

- yarn 2+ (berry): yarn.lock formats 4–8, `.yarnrc.yml`, `dependenciesMeta`, workspaces, for every rule
  (`Lockfile.kind: 'yarn-berry'`, `directFieldsMerged`, `cacheKey`, `LockedPackage.conditions`).
- `.yarnrc.yml` `yarnPath`, `plugins` (path and content hash) and `packageExtensions` dependencies are
  subjects of `new-dependency`; `YARN_*` variables in the gate's environment produce a report warning
  (`CheckReport.warnings`, `CheckOptions.env`).
- The YAML reader reads yarn files with the FAILSAFE schema; `0b`/`0o`/`0x` numbers like js-yaml;
  `npm:^1.0.0` without a name is the same package under its key.

### Migration

yarn 2+ projects are now judged by every rule: set `sources.registries` (yarn installs from
`https://registry.yarnpkg.com` by default), script decisions and, with platform packages,
`supportedArchitectures`. `switch` handlers over `Lockfile.kind` must handle the new value.

## [0.3.0] — 2026-11-16

Neighbouring forms of already closed bypasses; defaults and allow keys change.

### Fixed

- `.npmrc` (ini: sections, CR, quotes, comments) and `.yarnrc` (nesting) are read like the managers read
  them; a needed key inside an ini section, an array key or a nested `.yarnrc` key is "not read".
- YAML: a tab as a separator is a refusal; the subset is the one js-yaml and pnpm 12 share; multi-line
  flow collections in linear time.
- Case-insensitive protocols (`NPM:`, `JSR:`, `LINK:`, `FILE:`, `CATALOG:`).
- Non-registry dependencies and sources are keyed `name@source`; integrity needs a valid token of the
  exact length; workspace patterns, `prepare` of git dependencies, the pnpm 11+ placeholder, BOMs,
  `--now`, reason length counting.

### Added

- Verdict `matured` (exit code 0) for allowances of versions that have matured.
- Exported types `DanglingReference`, `LockedConfigDependency`, `CliIo`; `CheckReport.now`.

### Migration

- Allow keys for non-registry packages are `name@source`
  (`"plain-lib@file:vendor/plain-lib"`, `"gg@git+https://host/u/gg.git"`); old keys become stale and the
  finding names the new key. Rewrite the baseline file with `deps-guard baseline`.
- Move `registry`/`ignore-scripts` above ini sections in `.npmrc`; keep needed `.yarnrc` keys unindented.
- In hand-edited YAML replace tabs after `:`/`-`/`?` with spaces, `yes`/`no`/`True` with `true`/`false`,
  quote dates and `-0`.
- Handle the `matured` verdict; `DepsGuard.fetchMetadata` has `scopeRegistries`; `--now` is ISO 8601 only.

## [0.2.0] — 2026-11-16

Parsing and verdict correctness; defaults change.

### Fixed

- yarn 1 reads `ignore-scripts` from `.yarnrc`, not `.npmrc`; workspaces; `npm:` aliases; `file:`/`link:`
  without `resolved`.
- pnpm: script decisions only from the sources this version reads; config dependencies are direct;
  `overrides`, `excludeLinksFromLockfile` and dependencies in two fields no longer give false
  `lock-mismatch`; `catalog:` is judged by the catalog.
- npm `bundleDependencies`; YAML block scalars, explicit keys, multi-line flow collections; registries from
  the project's `.npmrc`/`.yarnrc`; dangling direct dependencies are violations; the install-script flag no
  longer comes from installed `node_modules`.

### Migration

- pnpm v9 projects without a metadata cache get "not verified" where the installed package used to be
  consulted: run `deps-guard metadata`.
- pnpm 11+: move `onlyBuiltDependencies`/`neverBuiltDependencies`/`ignoredBuiltDependencies` and the
  `pnpm` field into `allowBuilds` of pnpm-workspace.yaml; `ignore-scripts` into `ignoreScripts: true`.
- yarn 1: move `ignore-scripts=true` from `.npmrc` to `.yarnrc` or set `installScripts.othersBlockedBy`.
- Alias allowances are keyed by the target name; rewrite the baseline file; a `registry=` in `.npmrc` must
  be in `sources.registries`; run the gate before installing with scripts.

## [0.1.0] — 2026-11-15

First release: rules `new-dependency`, `install-script`, `source`, `typosquatting`, `freshness`,
`floating-range`, `lock-mismatch`; CLI `check` / `baseline` / `metadata`; text, JSON, SARIF 2.1.0 and JUnit
reports; the Jest gate.

[0.7.2]: https://github.com/HoshinoTatsuya/deps-guard/releases/tag/v0.7.2
