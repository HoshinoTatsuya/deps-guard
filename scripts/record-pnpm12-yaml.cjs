#!/usr/bin/env node
// Записывает, как pnpm 12 читает набор pnpm-workspace.yaml (fixtures/yaml-oracle/inputs.json):
// `pnpm config list --json` в одноразовом каталоге, с изолированным HOME и без сети
// (реестр — закрытый порт 127.0.0.1:9, загрузка версий corepack выключена). Результат —
// fixtures/yaml-oracle/pnpm12.json; спека сверяет с ним разборщик гейта.
//
// Использование: PNPM12=<путь к исполняемому pnpm 12> node scripts/record-pnpm12-yaml.cjs
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bin = process.env.PNPM12;
if (!bin) {
  console.error('нужна переменная PNPM12 — путь к исполняемому pnpm 12');
  process.exit(2);
}
const root = path.join(__dirname, '..', 'fixtures', 'yaml-oracle');
const inputs = JSON.parse(fs.readFileSync(path.join(root, 'inputs.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-guard-oracle-'));
const home = path.join(work, 'home');
fs.mkdirSync(home);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  npm_config_userconfig: path.join(home, '.npmrc'),
  npm_config_registry: 'http://127.0.0.1:9/',
  npm_config_manage_package_manager_versions: 'false',
  COREPACK_ENABLE_NETWORK: '0',
};
const version = execFileSync(bin, ['--version'], { cwd: work, env, encoding: 'utf8' }).trim();
if (!/^12\./.test(version)) {
  console.error(`ожидался pnpm 12, получен ${version}`);
  process.exit(2);
}
const project = path.join(work, 'p');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"oracle","version":"1.0.0"}');
const SETTINGS = ['packages', 'catalog', 'allowBuilds', 'ignoreScripts', 'dangerouslyAllowAllBuilds', 'configDependencies'];
const cases = inputs.map((text) => {
  fs.writeFileSync(path.join(project, 'pnpm-workspace.yaml'), text);
  try {
    const out = execFileSync(bin, ['config', 'list', '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const all = JSON.parse(out.slice(out.indexOf('{')));
    return { text, pnpm12: Object.fromEntries(SETTINGS.filter((key) => key in all).map((key) => [key, all[key]])) };
  } catch {
    return { text, pnpm12: null };
  }
});
fs.writeFileSync(path.join(root, 'pnpm12.json'), `${JSON.stringify({ pnpm: version, cases }, null, 2)}\n`);
fs.rmSync(work, { recursive: true, force: true });
console.log(`записано ${cases.length} случаев, pnpm ${version}`);
