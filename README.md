# @hoshinotatsuya/deps-guard

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/deps-guard.svg)](https://www.npmjs.com/package/@hoshinotatsuya/deps-guard)
[![CI](https://github.com/HoshinoTatsuya/deps-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/deps-guard/actions/workflows/ci.yml)

[Русская версия](README.ru.md) · [Changelog](CHANGELOG.md)

A supply-chain gate for npm dependencies, for CI and commit hooks. It guards the **entry** of a
dependency into the repository: a new dependency, a new install script, a new package source or a
look-alike name does not get in without an explicit decision with a reason. It reads only files of the
repository (`package.json`, the lock file, manager settings) — no network, no installed `node_modules` —
so the verdict is reproducible.

**It does not protect you from a malicious dependency at runtime.** A package that passed the gate (with
a reason, from an allowed registry, not fresh) runs with full rights; the gate only makes sure it did not
get into the tree unnoticed. Process isolation, network and file-system restrictions are the job of the
environment.

## Install

```sh
pnpm add -D @hoshinotatsuya/deps-guard
# optional, for the Jest gate:
pnpm add -D @jest/globals
```

Node.js **24 or newer**. No runtime dependencies. The only (optional) peer is `@jest/globals >= 29` for the
`./jest` subpath.

## Quick start

**1.** Put `deps-guard.json` into the project root. There are no defaults on purpose: defaults would judge
someone else's repository by someone else's registries, so without the file the gate refuses; an unknown
key is a refusal too, so a typo never silently disables a rule.

```json
{
  "newDependencies": {
    "baseline": { "gitRef": "origin/main" },
    "allow": { "date-fns": "date parsing in reports instead of hand-written code" }
  },
  "installScripts": {
    "allow": { "esbuild": "downloads the binary for its platform; the build needs it" }
  },
  "sources": {
    "registries": ["https://registry.npmjs.org/"],
    "defaultRegistry": "https://registry.npmjs.org/",
    "allow": {}
  },
  "typosquatting": { "allow": {} },
  "freshness": { "minAgeDays": 7, "metadataFile": "deps-guard.metadata.json", "allow": {} },
  "floatingRanges": { "fields": ["devDependencies"], "allow": {} },
  "bannedPackages": [
    { "name": "request", "reason": "deprecated by its author; use the built-in fetch instead" }
  ]
}
```

**2.** Fill the registry metadata cache once (publish dates and install-script flags of exactly the
versions in your lock file) and commit it — the check itself then runs offline:

```sh
pnpm exec deps-guard metadata --out deps-guard.metadata.json
git add deps-guard.json deps-guard.metadata.json
```

**3.** Run the check:

```sh
pnpm exec deps-guard check --base origin/main
```

Exit code `0` — clean, `1` — violations or stale allow entries, `2` — something could not be verified or
read (and nothing is violated). Every finding names the rule, verdict, file and line, the subject and the
reason; where an allowance applies, it names the exact key to write into `deps-guard.json`.

**4.** Put it into CI **before** any install script runs (see [CI](#ci)), or into the test suite:

```ts
// examples/deps-guard.spec.ts
import { join } from 'node:path';

import { depsGuardGate } from '@hoshinotatsuya/deps-guard/jest';

depsGuardGate({ root: join(__dirname, '..') });
```

The JSON above is [`examples/deps-guard.json`](examples/deps-guard.json) and is validated by the package's
own config parser in its tests; the TypeScript blocks are files from [`examples/`](examples), type-checked
against the package source by `pnpm run typecheck`.

## Allow entries

Every allow entry is `subject → reason`, and the reason must have at least 30 **visible** characters:
graphemes that contain a letter, digit, punctuation or symbol (an emoji, including ZWJ sequences, and a
letter with a combining accent count as one); spaces (also in the middle), zero-width and control
characters and "blank" fillers (U+115F, U+1160, U+3164, U+FFA0, U+2800) do not count. A shorter reason is a
violation and does not count as an allowance. An entry that no longer matches anything is **stale**, so the
allow list does not grow forever. A rule can be disabled only with a reason:
`"disabled": { "freshness": "…" }`; reading the inputs (`input`) cannot be disabled — that key is a refusal,
not silence.

## Rules

| rule | what it checks | settings |
|---|---|---|
| `new-dependency` | A direct dependency that is not in the baseline needs an entry in `newDependencies.allow`. A registry package is identified by its real name (an `npm:` alias — the target's name, case-insensitive protocol); a non-registry package by `name@source` (git — URL without the commit, tarball — URL, directory — path from the root, link — target), so changing the source under an old key (`aa-lib: https://…/bb-lib-1.0.0.tgz`, `aa-lib: evil/repo`) is a new dependency `aa-lib@<source>`; a new git commit is the same dependency. pnpm config dependencies (`configDependencies`, executed by pnpm before install) are direct too. The baseline is a git revision (`gitRef` or `--base`) or a baseline file (`file`, written by `deps-guard baseline`), computed over the whole repository: moving a dependency between workspace packages or renaming a package is not new code. An allowance for a removed dependency is stale | `newDependencies` |
| `install-script` | A package with `preinstall`/`install`/`postinstall` (or `binding.gyp`), including `bundleDependencies`, needs a decision: allowed (`installScripts.allow` or the manager's own decision) or explicitly blocked. A decision counts only if this manager version reads it (table below); a key that is set but not read is named in the finding. Also checks that the manager setting **really blocks the rest**: pnpm 10+ by default; pnpm < 10 only with `onlyBuiltDependencies`; `dangerouslyAllowAllBuilds` is a violation; an unpinned pnpm version (`packageManager` or `devEngines.packageManager`) is a violation. npm and yarn 1 have no lists: blocking is confirmed by `ignore-scripts` (npm — `.npmrc`, yarn — `.yarnrc`) or `installScripts.othersBlockedBy`, otherwise "not verified". The pnpm 11+ placeholder `allowBuilds: { dep: set this to true or false }` (any string instead of `true`/`false`) is no decision. pnpm 12.11+: `permissions.<pkg>.build: true\|false` is a decision and overrides `allowBuilds` of the same key. `packageManagerDependencies` (pnpm itself) need no decision. yarn 2+: without `enableScripts`, blocking the rest is the default of yarn 4.14+ (yarn.lock format 9+); yarn runs the `prepack` of a git dependency regardless of settings — only `installScripts.allow` decides. For git dependencies and local directories `prepare` is an install script too | `installScripts`, manager settings |
| `source` | Every package comes from an allowed registry (case-insensitive scheme, host without a trailing dot, port and path prefix; `registry.npmjs.org.evil.example`, a URL with credentials, a path with an encoded `/` or `\` do not pass) and has an integrity with at least one valid sha256/384/512 token of the exact hash length (a truncated `sha512-` is dropped by managers and the tarball is not verified). git (including `ssh://` and `git@host:`), `file:`, directories, http outside a registry, links outside the repository (including absolute `link:/…`) and unrecognised entries are violations without `sources.allow["name@source"]` (the finding names the exact key); git only with a commit. An allowance never waives integrity. A package without a URL in the lock file (pnpm v9 omits the default registry) is installed from the install registry: `registry`/`@scope:registry` in the project's `.npmrc` (yarn 1 — also `.yarnrc`) outside `sources.registries` is a violation; when the project does not set it — judged by `sources.defaultRegistry`, otherwise "not verified" | `sources` |
| `typosquatting` | The name of every package and direct dependency does not look like a popular one: mixed `-`/`_`/`.` and case (`cross_env`), swapped parts (`env-cross`), a replaced scope (`@types-x/node`, `@typess/node`), edit distance with adjacent transpositions (`lodahs`; threshold 1 for names of 5–9 characters, 2 from 10, short names are not judged). The list is `data/popular-packages.json` of the package or your own (`popularFile`, `{ "names": [...] }`); an empty list is a refusal | `typosquatting` |
| `freshness` | A registry version was published at least `minAgeDays` (default 7) days ago. The date comes from the metadata cache in the repository (`metadataFile`) or from the caller. No date — "not verified", a date in the future — violation. Allowance key `name@version`; once the version has matured the allowance is reported as `matured` (a warning, exit code unchanged); an allowance for a version not in the lock file is stale | `freshness` |
| `floating-range` | Direct dependencies of the checked fields have no forbidden range kinds: `caret` (`^`), `tilde` (`~`), `x-range` (`1.x`), `any` (`*`), `tag` (`latest`), `comparator` (`>=`, `\|\|`). By default every kind is forbidden in all three fields; a library usually wants `"fields": ["devDependencies"]`. `npm:` and `jsr:` are judged by the target range, `catalog:` by the pnpm catalog. Paths, `workspace:`, `file:`, git and URLs are not ranges (judged by `source`). An unparseable specifier is always a violation | `floatingRanges` |
| `banned-package` | The installed tree contains none of the `bannedPackages` (`[{ "name", "reason" }]`): not direct, not transitive, not peers the manager installs (pnpm and npm 7+ install required peers, yarn does not), not optional (including other platforms — they are in the lock file), not under an alias — the real package name is judged. The tree comes from the lock file of any supported format; installed `node_modules` are not read. The finding is `name@version` with the lock-file line, the reason and the chains from direct dependencies (`package.json devDependencies.kit: kit@1.0.0 → orm-adapter@1.0.0 → x@1.0.0`, the shortest per direct dependency, first five). No key or an empty list forbids nothing (it is the project's list, not access control). An entry without a reason (under 30 visible characters), with a name that is not a registry package name, with an extra key, or a duplicate is a config refusal | `bannedPackages` |
| `lock-mismatch` | `package.json` and the lock file agree: every workspace project is in the lock file, every direct dependency is recorded with the same specifier in the same field, there are no extra ones, and each points to a package present in the lock file (otherwise the tree was checked by no rule). Legitimate differences are accepted: specifiers from pnpm `overrides`, `link:` with `excludeLinksFromLockfile`, a dependency in two fields, yarn 1 workspace dependencies. pnpm config dependencies match; the range of every used pnpm catalog entry matches `catalogs.<name>` of the lock file | — |
| `input` | not a supply-chain rule: the inputs (settings, lock file, `package.json`) were read. An unreadable input is a refusal of the gate, never a skipped check | — |

## Verdicts and exit codes

| verdict | meaning | exit code |
|---|---|---|
| `violation` | a rule is violated | 1 |
| `stale` | an allow entry that matches nothing | 1 |
| `unverified` | not verified: data is missing (a date, the install-script flag, the baseline) | 2 if there are no violations |
| `broken` | an input could not be read: a broken lock file, settings, baseline | 2 if there are no violations |
| `matured` | a freshness allowance is no longer needed (remove it) | 0 — a warning |

"Could not parse the lock file" is a refusal with a line number, never a skip. The YAML reader accepts what
pnpm (and prettier on top of it) writes, and what it reads must match how BOTH manager parsers read it:
js-yaml (pnpm before 11) and pnpm 12's own parser. Anything one of them reads differently is a refusal:
anchors, tags, merge keys `<<`, a lone CR, NEL, C1 and Unicode line separators, a BOM not at the start,
lines starting with `---`/`...` that are not document markers, tabs in indentation or as separators, plain
scalars that js-yaml reads as numbers (`1.10`, `010`, `1e3`, `-0`) or dates (`2027-01-13`), YAML 1.1 booleans
(`yes`, `no`, `on`, `off`, `y`, `n`, `True`, `FALSE`), duplicate keys, comments inside flow collections.
Multi-line flow collections are parsed in linear time. An unread input makes every rule "not read".

## CLI

```sh
deps-guard check [--root DIR] [--base REF] [--format text|json|sarif|junit] [--out FILE] [--now ISO]
deps-guard baseline [--root DIR] [--out FILE]
deps-guard metadata [--root DIR] [--registry URL] [--out FILE] [--timeout-ms N]
```

* `check --out` writes the report in the chosen format to a file and prints text to the log. `--now` is an
  ISO 8601 date (`2026-11-16` or `2026-11-16T10:00:00Z`); anything else, or a time more than a day in the
  future, is a refusal (a future reference time would silently disable freshness). The reference time is
  printed in every report. SARIF 2.1.0: "not verified" is `kind: review`, not `pass`. JUnit: a violation is
  `<failure>`, "not verified" and "not read" are `<error>`, a disabled rule is `<skipped>` with its reason.
* `baseline` writes the baseline file of the current direct dependencies (for `newDependencies.baseline.file`).
* `metadata` downloads publish dates of exactly the versions in the lock file and the install-script flag,
  and merges them into the cache. The document comes from the registry the package is installed from:
  `--registry`, otherwise `registry` from the project's `.npmrc`, otherwise `sources.defaultRegistry`; a
  scoped package — from `@scope:registry`; a tarball URL — from the registry that owns it (layout
  `<registry>/<name>/-/<file>`; a URL outside the layout or a package from two registries is an error, never
  data of a same-named public package). Each request has a deadline (`--timeout-ms`, default 15 s); a
  package that could not be fetched is not written and is named in the errors (exit code 2). The
  `Authorization` header for a private registry comes from `DEPS_GUARD_REGISTRY_AUTH` and is sent only to
  the default registry — never to scope registries or tarball hosts. Credentials inside a registry URL are
  never used or printed.

Report texts, rule titles and CLI messages are in Russian; rule ids, verdicts, exit codes and the JSON /
SARIF / JUnit structure are stable and language-independent.

## CI

The gate must run **before any install script executes**: npm and yarn run scripts during install, and a
gate after `npm ci` is too late. The gate itself has no scripts and does not need the project installed (it
reads repository files), so install it without scripts first and install the project afterwards:

```yaml
deps-guard:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v5
      with: { fetch-depth: 0 }
    - uses: actions/setup-node@v5
      with: { node-version: 24 }
    - run: npm install --no-save --ignore-scripts --prefix /tmp/deps-guard @hoshinotatsuya/deps-guard@<version>
    - run: /tmp/deps-guard/node_modules/.bin/deps-guard check --base "origin/${{ github.base_ref || 'main' }}" --format sarif --out deps-guard.sarif
```

If the gate is already in your devDependencies, install without scripts before it
(`pnpm install --frozen-lockfile --ignore-scripts`, `npm ci --ignore-scripts`,
`yarn install --frozen-lockfile --ignore-scripts`). The verdict does not depend on the installation: the gate
never reads `node_modules`.

## Jest gate

`depsGuardGate(options)` from `@hoshinotatsuya/deps-guard/jest` takes the `check` options plus `title`
(default `'deps-guard: цепочка поставок зависимостей'`) and registers one `it` per rule: findings are in the
failure message, "not verified" is a red test too, a disabled rule is `it.skip` with the reason in its name.

## API

```ts
// examples/check.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DepsGuard, EXIT_CODE, type PackageMetadata } from '@hoshinotatsuya/deps-guard';

export function runGate(root: string): number {
  const report = DepsGuard.check({ root, baseRef: 'origin/main' });
  process.stdout.write(DepsGuard.render('text', report));
  writeFileSync(join(root, 'deps-guard.sarif'), DepsGuard.render('sarif', report));
  const code = DepsGuard.exitCode(report);
  if (code === EXIT_CODE.unverified) {
    // Nothing is violated, but something could not be checked: this is not green.
    const unverified = report.findings.filter((finding) => finding.verdict === 'unverified');
    console.error(`not verified: ${unverified.map((finding) => finding.subject).join(', ')}`);
  }
  return code; // 0 clean, 1 findings, 2 not verified
}

export async function refreshMetadata(root: string): Promise<Record<string, PackageMetadata>> {
  const lockfile = DepsGuard.readLockfile(root);
  const { metadata, errors } = await DepsGuard.fetchMetadata({
    registry: 'https://registry.npmjs.org/',
    packages: lockfile.packages,
    timeoutMs: 15_000,
  });
  if (errors.length > 0) {
    throw new Error(`metadata not fetched for ${errors.length} packages: ${errors.join('; ')}`);
  }
  return metadata;
}
```

| export | what it does |
|---|---|
| `DepsGuard.check(options)` | runs every rule → `CheckReport` (`tool`, `root`, `lockfile`, `now`, `warnings`, `rules`, `findings`). Never throws on an unreadable input — that is the `broken` verdict |
| `CheckOptions` | `root` (required); `config` (instead of reading `deps-guard.json`); `baseRef` (overrides the configured baseline); `metadata` (overrides the cache); `now` (default: current time); `env` (default: `process.env`, only names of `YARN_*` variables are reported) |
| `DepsGuard.exitCode(report)` | 0 clean, 1 findings, 2 not verified (`EXIT_CODE`) |
| `DepsGuard.render(format, report)` | `'text' \| 'json' \| 'sarif' \| 'junit'` |
| `DepsGuard.readLockfile(root, path?)` | the parsed lock file in a manager-independent shape (`Lockfile`); throws `InputUnreadableError` |
| `DepsGuard.renderBaseline(root, lockfilePath?)` | text of the baseline file |
| `DepsGuard.fetchMetadata(options)` | `{ registry, scopeRegistries, packages, timeoutMs = 15_000, authorization, concurrency = 8 }` → `{ metadata, errors }` |
| `LoadConfig.fromRoot(root)`, `LoadConfig.validate(value)` | read / validate `deps-guard.json` (`DepsGuardConfig`); throws on unknown keys and bad values |
| `RULE`, `RANGE_KINDS`, `MIN_REASON_LENGTH`, `EXIT_CODE` | frozen constants |
| types | `DepsGuardConfig`, `CheckOptions`, `CheckReport`, `Finding` (`rule`, `verdict`, `path`, `line`, `subject`, `reason`), `Verdict`, `RuleId`, `RuleSummary`, `Lockfile`, `LockedPackage`, `PackageMetadata`, `BannedPackage`, … |

## Supported lock files

* `pnpm-lock.yaml` 6.x and 9.x, including multiple documents (pnpm 11+ writes the environment document
  first — pnpm itself and config dependencies; they are checked too).
* `package-lock.json` / `npm-shrinkwrap.json` versions 2 and 3.
* `yarn.lock` v1, with workspaces (projects from `workspaces` in `package.json`).
* `yarn.lock` of yarn 2+ (berry), `__metadata.version` 4–10 (yarn 4.13 writes 8, 4.14 — 9, 4.15+ — 10). The
  format is detected like yarn does: `# yarn lockfile v1` at the top — yarn 1, otherwise berry YAML.
* Two lock files side by side without the `lockfile` key — refusal: it is unknown which one CI installs.
* Workspace projects are directories: pnpm — `packages` of pnpm-workspace.yaml, npm and yarn — `workspaces`
  of `package.json`. Patterns `*`, `?`, `**`, `!exclude`; other glob syntax (`{a,b}`, `[ab]`, `@(…)`), `\` and
  paths outside the root are refusals. `node_modules` and `.git` are not walked; a symlinked directory or one
  deeper than 32 levels is "not read".

**What managers read about install scripts** (measured on pnpm 9.15, 11.1, 12.4, 12.10.1, 12.11.0, 12.21.0,
yarn 1.22 and yarn 4.0.2–4.18.1; pnpm 10 is not measured — every source is read for it):

| manager | reads | does not read |
|---|---|---|
| npm | `ignore-scripts=true` in `.npmrc` | — |
| yarn 1 | `ignore-scripts true` in `.yarnrc` | `.npmrc` (yarn 1 runs postinstall with `ignore-scripts=true` there) |
| pnpm < 10 | `pnpm` field of `package.json`: `onlyBuiltDependencies`, `onlyBuiltDependenciesFile`, `neverBuiltDependencies`; `ignore-scripts` in `.npmrc` | pnpm-workspace.yaml settings, `allowBuilds`, `ignoredBuiltDependencies` |
| pnpm 11+ | pnpm-workspace.yaml: `allowBuilds`, `dangerouslyAllowAllBuilds`, `ignoreScripts` | the `pnpm` field, `.npmrc`, `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies`; `permissions` before 12.11 |
| pnpm 12.11+ | also `permissions.<key>.build` (overrides `allowBuilds`); the version from `packageManager` or the lower bound of `devEngines.packageManager` | — |
| yarn 2+ | `enableScripts` in `.yarnrc.yml` (without it, the yarn.lock format: 9+ blocks); `dependenciesMeta.<pkg>.built` | `.npmrc`, `.yarnrc` |

**yarn 2+ details.** yarn reads yarn.lock and `.yarnrc.yml` with js-yaml's FAILSAFE schema (every scalar is a
string); the gate reads them the same way with the same strict subset. The source is judged by the
`resolution` locator protocol (`npm:`, `patch:`, `workspace:`, `link:`, `portal:`, `file:`; `exec:` is an
unrecognised source and an install script; git is always a `source` violation without an allowance). A
`checksum` with a prefix other than the current `cacheKey` is not verified by yarn at all (measured), so
it, a truncated and a missing checksum are violations; `checksumBehavior` other than `throw` is a violation.
The install registry is `npmRegistryServer` / `npmScopes.<scope>.npmRegistryServer`. `yarnPath` and
`plugins` (code any yarn command executes) and `packageExtensions` dependencies are subjects of
`new-dependency`. `YARN_*` variables in the gate's own environment produce a warning (names only).

## Guarantees and limits

* **The install-script flag** is not stored in pnpm v9 and yarn lock files. Sources: the lock file (pnpm v6
  `requiresBuild`, npm `hasInstallScript`), registry metadata, the `package.json` of a local directory.
  Installed `node_modules` are never a source. Packages without data are "not verified"; the
  `deps-guard metadata` cache closes that completely. Registry metadata is stricter than installation (the
  registry adds an implicit `install: node-gyp rebuild` to packages with `gypfile`): the gate takes the strict
  answer.
* `.npmrc` and `.yarnrc` are read only for `ignore-scripts`, `dangerously-allow-all-builds`, `registry` and
  `@scope:registry`, the way the manager reads them; a key that managers read differently (inside an ini
  section, with a `[]` suffix, nested in `.yarnrc`) is "not read". Other lines are never parsed or printed
  (tokens live there; a test checks that a token value appears in no finding and no report format).
  The user's or global `.npmrc` and CI environment variables are invisible to the gate — set
  `sources.defaultRegistry`.
* **Look-alike names** are a heuristic over a list. Dropping a scope (`types-node` next to `@types/node`) is
  not caught (legitimate packages look like that); names inside a popular scope are not judged (only the
  scope owner publishes there). For your ecosystem replace the list (`popularFile`).
* **The live registry is never queried** except by `metadata`. pnpm's `minimumReleaseAge` and yarn's
  `npmMinimalAgeGate` act at install time and are not replaced; the gate catches a fresh version that got
  into the lock file before such a setting was enabled or through another manager.
* Verified against real managers (isolated user config, a fake registry on 127.0.0.1): the install-script
  decision model, registries from `.npmrc`/`.yarnrc`, and the YAML subset on 156 real lock and workspace
  files (all agree with js-yaml; 52 settings files and 100 lock files agree with pnpm 12) plus recorded
  pnpm 12 answers to hostile inputs (`fixtures/yaml-oracle`). **Not measured**: registries with a
  non-standard layout; Windows paths in a lock file on real Windows.

## Failure behaviour

Fail-closed throughout: a missing `deps-guard.json`, an unknown key, an empty popular-names list, an
unparseable lock file or setting, a missing baseline revision are refusals (`broken`, exit code 2), never a
silently passing rule. Missing data (no publish date, no install-script flag, a registry that only the CI
environment knows) is `unverified` (exit code 2) — distinct from both success and violation. A violation
always wins: exit code 1 whenever there is a violation or a stale entry.

## Compatibility

* Node.js ≥ 24.
* Package managers: npm (lock files v2/v3; checked with npm 12.2.2), yarn 1 (1.22.22), yarn 2+ (4.0.2–4.18.1,
  lock formats 4–10), pnpm 6/9 lock files (pnpm 9.15–12.21.0).
* Consumer projects: CommonJS (`node10`, without the exports map), `node16`, `nodenext`, ESM `nodenext` and
  `bundler`, all with `strict` + `exactOptionalPropertyTypes` and `skipLibCheck: false`
  (`pnpm run test:consumers`).
* Jest ≥ 29 for `./jest`.

## Testing and development

```sh
pnpm install
pnpm run typecheck        # src and examples/
pnpm run lint             # biome
pnpm test                 # build, then Jest in sequential groups of at most 300 tests, 2 workers
pnpm run test:consumers   # packed package in throwaway CJS/ESM projects + the installed CLI on real lock files
pnpm run build
```

The suite needs only git (baseline specs and the end-to-end CLI run create git repositories; a fake
registry listens on 127.0.0.1). Every rule is tested with fixtures that contain both an allowed AND a
forbidden case; lock files in `fixtures/` were written by the real managers from a fake registry
(`scripts/record-banned-package-fixtures.cjs`, `scripts/record-pnpm12-yaml.cjs`). `test:consumers` installs
the packed package and its dev tools from the registry.

## License

[MIT](LICENSE) © 2026 Hoshino Tatsuya
