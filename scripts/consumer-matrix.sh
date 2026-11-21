#!/usr/bin/env bash
# Матрица потребителей: собранный пакет (npm pack) ставится в одноразовые
# проекты с разными настройками модулей (CommonJS node10 без карты exports,
# node16, nodenext, ESM с nodenext и с bundler), везде strict +
# exactOptionalPropertyTypes и БЕЗ skipLibCheck: декларации пакета проверяются
# компилятором потребителя. Подпути берутся из карты `exports` package.json, а
# не списком здесь: новый вход без проверки не останется. В каждом проекте —
# tsc, загрузка каждого входа в рантайме (require для CJS, import для ESM),
# у CJS-проектов — ts-jest, и запуск установленного CLI (`bin`) на маленьком
# проекте с ожидаемым кодом выхода.
#
# Установка — только из локального хранилища pnpm (--offline), без сети.
# Запуск: scripts/consumer-matrix.sh (или pnpm run test:consumers) под общей
# блокировкой прогонов. Каталоги — из mkdtemp, удаляются в конце.
set -euo pipefail
export COREPACK_ENABLE_NETWORK=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/deps-guard-consumers-XXXXXX")"
cleanup() {
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/deps-guard-consumers-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT

(cd "${ROOT}" && pnpm build >/dev/null && npm pack --silent --pack-destination "${WORK}" >/dev/null)
TARBALL="$(ls "${WORK}"/hoshinotatsuya-deps-guard-*.tgz)"
VERSION="$(node -p 'require(process.argv[1]).version' "${ROOT}/package.json")"

# Входы пакета из карты exports: '.' → '@hoshinotatsuya/deps-guard', './jest' → '@hoshinotatsuya/deps-guard/jest'.
# bash 3.2 (macOS) без mapfile — чтение построчно.
ENTRIES=()
while IFS= read -r entry; do
  ENTRIES+=("${entry}")
done < <(node -e '
  const p = require(process.argv[1]);
  for (const key of Object.keys(p.exports)) {
    if (key.endsWith(".json")) continue;
    console.log(key === "." ? p.name : p.name + key.slice(1));
  }' "${ROOT}/package.json")
if [[ "${#ENTRIES[@]}" -lt 2 ]]; then
  echo "карта exports дала ${#ENTRIES[@]} входов — ожидалось не меньше 2"; exit 1
fi

# Импорт каждого входа + использование типов с необязательными полями (exactOptionalPropertyTypes)
# + утверждение, что ни один экспорт не стал any (нерезолвящийся тип молча превращается в any).
CONSUMER_TS="$(
  for index in "${!ENTRIES[@]}"; do echo "import * as entry${index} from '${ENTRIES[index]}';"; done
  cat <<'TS'
import {
  DepsGuard,
  EXIT_CODE,
  type CheckOptions,
  type CheckReport,
  type DanglingReference,
  type FetchMetadataOptions,
  type LockedConfigDependency,
  type Verdict,
} from '@hoshinotatsuya/deps-guard';
import { depsGuardGate } from '@hoshinotatsuya/deps-guard/jest';

type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : true;
export const typed: [
  NotAny<typeof DepsGuard>, NotAny<typeof depsGuardGate>, NotAny<CheckReport>, NotAny<DanglingReference>,
  NotAny<LockedConfigDependency>,
] = [true, true, true, true, true];

const options: CheckOptions = { root: '.', baseRef: 'origin/main', now: new Date(0) };
const fetchOptions: FetchMetadataOptions = {
  registry: 'http://127.0.0.1:9/',
  packages: [],
  scopeRegistries: { '@corp': 'http://127.0.0.1:9/' },
  timeoutMs: 1000,
};
const verdict: Verdict = 'matured';
export const usage = {
  check: () => DepsGuard.check(options),
  code: (report: CheckReport) => DepsGuard.exitCode(report) === EXIT_CODE.clean,
  fetch: () => DepsGuard.fetchMetadata(fetchOptions),
  verdict,
};
TS
  printf 'export const entries = [%s];\n' "$(for index in "${!ENTRIES[@]}"; do printf 'entry%s, ' "${index}"; done)"
)"

SPEC_TS="import { entries } from './consumer';

it('каждый вход пакета грузится и что-то экспортирует', () => {
  expect(entries.map((entry) => Object.keys(entry).length > 0)).toEqual(entries.map(() => true));
});
"

# Вход `/jest` объявляет тесты через @jest/globals, а тот грузится только в среде jest: вне неё
# у этого входа проверяется разрешение пути и наличие файла, загрузка — в ts-jest (CJS-проекты).
RUNTIME_CJS="const fs = require('fs'); const names = JSON.parse(process.argv[1]);
for (const name of names) {
  if (name.endsWith('/jest')) { const file = require.resolve(name); if (!fs.existsSync(file)) { console.error('нет файла: ' + file); process.exit(1); } continue; }
  const m = require(name); if (Object.keys(m).length === 0) { console.error('пусто: ' + name); process.exit(1); }
}"
RUNTIME_ESM="import { existsSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; const names = JSON.parse(process.argv[1]);
for (const name of names) {
  if (name.endsWith('/jest')) { const file = fileURLToPath(import.meta.resolve(name)); if (!existsSync(file)) { console.error('нет файла: ' + file); process.exit(1); } continue; }
  const m = await import(name); if (Object.keys(m).filter((k) => k !== 'default').length === 0) { console.error('пусто: ' + name); process.exit(1); }
}"
NAMES_JSON="$(printf '%s\n' "${ENTRIES[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0, "utf8").trim().split("\n")))')"

failures=0
run_case() {
  local label="$1" module="$2" resolution="$3" type="$4" jest="$5"
  local dir="${WORK}/${label}"
  mkdir -p "${dir}/src"
  cat >"${dir}/package.json" <<JSON
{
  "name": "consumer-${label}",
  "private": true,
  "type": "${type}",
  "dependencies": {
    "@hoshinotatsuya/deps-guard": "file:${TARBALL}"
  },
  "devDependencies": {
    "@jest/globals": "30.2.0",
    "@types/jest": "30.0.0",
    "@types/node": "24.0.15",
    "jest": "30.2.0",
    "ts-jest": "29.4.5",
    "typescript": "5.9.3"
  }
}
JSON
  local resolution_line=""
  if [[ -n "${resolution}" ]]; then
    resolution_line="\"moduleResolution\": \"${resolution}\","
  fi
  cat >"${dir}/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "module": "${module}",
    ${resolution_line}
    "target": "ES2023",
    "lib": ["ES2023"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "types": ["jest", "node"],
    "noEmit": true
  },
  "include": ["src"]
}
JSON
  printf '%s\n' "${CONSUMER_TS}" >"${dir}/src/consumer.ts"
  if [[ "${type}" == "module" && "${resolution}" == "nodenext" ]]; then
    printf '%s' "${SPEC_TS}" | sed "s#'./consumer'#'./consumer.js'#" >"${dir}/src/consumer.spec.ts"
  else
    printf '%s' "${SPEC_TS}" >"${dir}/src/consumer.spec.ts"
  fi
  cat >"${dir}/jest.config.js" <<'JS'
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
};
JS
  (cd "${dir}" && pnpm install --prefer-offline --silent >"${dir}/install.log" 2>&1) || {
    echo "${label}: установка не прошла"; tail -5 "${dir}/install.log"; failures=$((failures + 1)); return
  }
  if (cd "${dir}" && node_modules/.bin/tsc -p tsconfig.json >"${dir}/tsc.log" 2>&1); then
    echo "${label}: tsc — зелёный"
  else
    echo "${label}: tsc — КРАСНЫЙ"; head -8 "${dir}/tsc.log"; failures=$((failures + 1))
  fi
  local ok
  if [[ "${type}" == "module" ]]; then
    (cd "${dir}" && node --input-type=module -e "${RUNTIME_ESM}" "${NAMES_JSON}" >"${dir}/runtime.log" 2>&1) && ok=1 || ok=0
  else
    (cd "${dir}" && node --input-type=commonjs -e "${RUNTIME_CJS}" "${NAMES_JSON}" >"${dir}/runtime.log" 2>&1) && ok=1 || ok=0
  fi
  if [[ "${ok}" == 1 ]]; then
    echo "${label}: рантайм ${#ENTRIES[@]} входов — зелёный"
  else
    echo "${label}: рантайм входов — КРАСНЫЙ"; head -5 "${dir}/runtime.log"; failures=$((failures + 1))
  fi
  if [[ "${jest}" == "jest" ]]; then
    if (cd "${dir}" && node_modules/.bin/jest --maxWorkers=2 >"${dir}/jest.log" 2>&1); then
      echo "${label}: ts-jest — зелёный ($(grep -E '^Tests:' "${dir}/jest.log"))"
    else
      echo "${label}: ts-jest — КРАСНЫЙ"; grep -E 'TS[0-9]+|Tests:' "${dir}/jest.log" | head -5; failures=$((failures + 1))
    fi
  fi
  run_cli "${label}" "${dir}"
}

# Установленный CLI (`bin`) на маленьком npm-проекте: чистый — код 0 и своя версия в отчёте;
# с новой зависимостью без допуска — код 1.
run_cli() {
  local label="$1" dir="$2" project="${2}/cli-project"
  mkdir -p "${project}"
  printf '{ "name": "cli-project", "private": true }\n' >"${project}/package.json"
  printf '{ "name": "cli-project", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "cli-project" } } }\n' \
    >"${project}/package-lock.json"
  printf '{ "dependencies": [] }\n' >"${project}/base.json"
  cat >"${project}/deps-guard.json" <<'JSON'
{
  "newDependencies": { "baseline": { "file": "base.json" } },
  "installScripts": { "othersBlockedBy": "установка в CI идёт с --ignore-scripts, проверено в конфигурации" },
  "sources": { "registries": ["https://registry.npmjs.org/"], "defaultRegistry": "https://registry.npmjs.org/" }
}
JSON
  local out code
  set +e
  out="$(cd "${project}" && "${dir}/node_modules/.bin/deps-guard" check --now 2026-01-01 2>&1)"; code=$?
  set -e
  if [[ "${code}" == 0 && "${out}" == *"deps-guard ${VERSION}"* && "${out}" == *"→ код 0"* ]]; then
    echo "${label}: CLI на чистом проекте — код 0"
  else
    echo "${label}: CLI на чистом проекте — КРАСНЫЙ (код ${code})"; echo "${out}" | tail -5; failures=$((failures + 1))
  fi
  printf '{ "name": "cli-project", "private": true, "dependencies": { "x": "1.0.0" } }\n' >"${project}/package.json"
  set +e
  out="$(cd "${project}" && "${dir}/node_modules/.bin/deps-guard" check --now 2026-01-01 2>&1)"; code=$?
  set -e
  if [[ "${code}" == 1 && "${out}" == *"[new-dependency/violation] x"* ]]; then
    echo "${label}: CLI с новой зависимостью — код 1"
  else
    echo "${label}: CLI с новой зависимостью — КРАСНЫЙ (код ${code})"; echo "${out}" | tail -5; failures=$((failures + 1))
  fi
}

# Установленный CLI на настоящих lock-файлах последних менеджеров (fixtures/latest и
# fixtures/yarn-berry-project/formats: npm 12.2.2, yarn 1.22.22, pnpm 12.21.0, yarn 4.13.0/4.14.1/4.18.1):
# каждое правило прочитало вход (нет «НЕ ПРОЧИТАНО», код не 2), отчёт назвал свой lock-файл.
run_latest() {
  local label="$1" dir="$2" fixture lockname project out code
  for fixture in latest/npm-12.2.2:package-lock.json latest/yarn-1.22.22:yarn.lock latest/pnpm-12.21.0:pnpm-lock.yaml \
    yarn-berry-project/formats/v8-yarn-4.13.0:yarn.lock yarn-berry-project/formats/v9-yarn-4.14.1:yarn.lock \
    yarn-berry-project/formats/v10-yarn-4.18.1:yarn.lock; do
    lockname="${fixture#*:}"; fixture="${fixture%%:*}"
    project="${dir}/latest-$(basename "${fixture}")"
    mkdir -p "${project}" && cp -R "${ROOT}/fixtures/${fixture}/." "${project}/"
    printf '{ "dependencies": [] }\n' >"${project}/base.json"
    cat >"${project}/deps-guard.json" <<'JSON'
{
  "newDependencies": { "baseline": { "file": "base.json" } },
  "sources": {
    "registries": ["https://registry.npmjs.org/", "https://registry.yarnpkg.com/", "http://127.0.0.1:48721/"],
    "defaultRegistry": "https://registry.npmjs.org/"
  }
}
JSON
    set +e
    out="$(cd "${project}" && "${dir}/node_modules/.bin/deps-guard" check --now 2026-11-17 2>&1)"; code=$?
    set -e
    if [[ "${code}" != 2 && "${out}" != *"НЕ ПРОЧИТАНО"* && "${out}" == *"deps-guard ${VERSION} — ${lockname}"* ]]; then
      echo "${label}: CLI на ${fixture} — прочитан всеми правилами (код ${code})"
    else
      echo "${label}: CLI на ${fixture} — КРАСНЫЙ (код ${code})"; echo "${out}" | grep -E 'НЕ ПРОЧИТАНО|broken' | head -5
      failures=$((failures + 1))
    fi
  done
}

run_case commonjs commonjs node10 commonjs jest
run_latest commonjs "${WORK}/commonjs"
run_case node16 node16 node16 commonjs jest
run_case nodenext nodenext nodenext commonjs jest
run_case bundler-esm esnext bundler module tsc-only
run_case nodenext-esm nodenext nodenext module tsc-only

if [[ "${failures}" -gt 0 ]]; then
  echo "матрица потребителей: красных ${failures}"
  exit 1
fi
echo "матрица потребителей: все зелёные"
