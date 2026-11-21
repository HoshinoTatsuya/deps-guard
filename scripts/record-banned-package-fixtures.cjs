#!/usr/bin/env node
// Записывает lock-файлы фикстур правила banned-package настоящими менеджерами: npm, pnpm,
// yarn 1 и yarn 2+ ставят одни и те же синтетические проекты из поддельного реестра на
// 127.0.0.1 (пакеты собираются здесь же, в памяти), с изолированным HOME и без сети.
// Результат — fixtures/banned-package/<менеджер>/<случай>/ (package.json и lock-файл).
//
// Использование:
//   NPM=<npm> PNPM=<pnpm> YARN1=<yarn 1> YARN_BERRY=<yarn-4.x.cjs> node scripts/record-banned-package-fixtures.cjs
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = 48731;
const REGISTRY = `http://127.0.0.1:${PORT}/`;
const BINS = { npm: process.env.NPM, pnpm: process.env.PNPM, yarn1: process.env.YARN1, berry: process.env.YARN_BERRY };
for (const [manager, bin] of Object.entries(BINS)) {
  if (!bin) {
    console.error(`нужна переменная для ${manager}: NPM, PNPM, YARN1, YARN_BERRY`);
    process.exit(2);
  }
}

/** Пакеты реестра: запрещённый, цепочки к нему всеми путями установки и чистый. */
const PACKAGES = [
  { name: 'old-orm', version: '1.0.0' },
  { name: 'orm-adapter', version: '1.0.0', dependencies: { 'old-orm': '^1.0.0' } },
  { name: 'kit', version: '1.0.0', dependencies: { 'orm-adapter': '^1.0.0' } },
  { name: 'needs-orm', version: '1.0.0', peerDependencies: { 'old-orm': '^1.0.0' } },
  {
    name: 'maybe-orm',
    version: '1.0.0',
    peerDependencies: { 'old-orm': '^1.0.0' },
    peerDependenciesMeta: { 'old-orm': { optional: true } },
  },
  { name: 'opt-kit', version: '1.0.0', optionalDependencies: { 'old-orm': '^1.0.0' } },
  { name: 'alias-kit', version: '1.0.0', dependencies: { db: 'npm:old-orm@^1.0.0' } },
  { name: 'clean-lib', version: '1.0.0' },
];

/** Проекты: разрешённый (запрещённый пакет только объявлен необязательным peer) и запрещённые. */
const CASES = {
  allowed: { dependencies: { 'clean-lib': '^1.0.0', 'maybe-orm': '^1.0.0' } },
  direct: { dependencies: { 'old-orm': '^1.0.0' } },
  transitive: { devDependencies: { kit: '^1.0.0' } },
  peer: { dependencies: { 'needs-orm': '^1.0.0' } },
  optional: { dependencies: { 'opt-kit': '^1.0.0' } },
  'alias-direct': { dependencies: { db: 'npm:old-orm@^1.0.0' } },
  'alias-transitive': { dependencies: { 'alias-kit': '^1.0.0' } },
  workspace: { workspace: { dependencies: { kit: '^1.0.0' } } },
};

function tarball(manifest) {
  const body = Buffer.from(JSON.stringify(manifest, null, 2));
  const header = Buffer.alloc(512);
  const put = (text, offset, length) => header.write(text, offset, length, 'ascii');
  put('package/package.json', 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return zlib.gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]), { level: 9 });
}

const docs = new Map();
const files = new Map();
for (const manifest of PACKAGES) {
  const tgz = tarball(manifest);
  const file = `${manifest.name}-${manifest.version}.tgz`;
  files.set(`${manifest.name}/-/${file}`, tgz);
  docs.set(manifest.name, {
    name: manifest.name,
    'dist-tags': { latest: manifest.version },
    time: { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z', [manifest.version]: '2020-01-01T00:00:00.000Z' },
    versions: {
      [manifest.version]: {
        ...manifest,
        dist: {
          tarball: `${REGISTRY}${manifest.name}/-/${file}`,
          integrity: `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`,
          shasum: crypto.createHash('sha1').update(tgz).digest('hex'),
        },
      },
    },
  });
}

const server = http.createServer((request, response) => {
  const url = decodeURIComponent((request.url ?? '/').split('?')[0]).slice(1);
  if (files.has(url)) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(files.get(url));
    return;
  }
  if (docs.has(url)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(docs.get(url)));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not found"}');
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function project(dir, manager, spec) {
  const root = { name: 'fixture', version: '1.0.0', private: true };
  if (spec.workspace) {
    if (manager !== 'pnpm') {
      root.workspaces = ['packages/*'];
    }
    write(path.join(dir, 'packages', 'app', 'package.json'), `${JSON.stringify({ name: 'app', version: '1.0.0', ...spec.workspace }, null, 2)}\n`);
  } else {
    Object.assign(root, spec);
  }
  write(path.join(dir, 'package.json'), `${JSON.stringify(root, null, 2)}\n`);
  if (manager === 'pnpm' && spec.workspace) {
    write(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  }
  if (manager === 'berry') {
    write(
      path.join(dir, '.yarnrc.yml'),
      `npmRegistryServer: "${REGISTRY.slice(0, -1)}"\nunsafeHttpWhitelist:\n  - 127.0.0.1\nenableTelemetry: false\nnodeLinker: node-modules\nenableGlobalCache: false\n`,
    );
    write(path.join(dir, 'yarn.lock'), '');
  }
}

function run(manager, dir, home) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_cache: path.join(home, '.npm'),
    npm_config_registry: REGISTRY,
    COREPACK_ENABLE_NETWORK: '0',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_IGNORE_PATH: '1',
    YARN_GLOBAL_FOLDER: path.join(home, 'yarn-global'),
  };
  const commands = {
    npm: [BINS.npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']],
    pnpm: [BINS.pnpm, ['install', '--lockfile-only', '--ignore-scripts', `--registry=${REGISTRY}`, `--store-dir=${path.join(home, 'store')}`]],
    yarn1: [BINS.yarn1, ['install', '--ignore-scripts', '--no-default-rc', '--registry', REGISTRY, '--cache-folder', path.join(home, 'yarn-cache')]],
    berry: [process.execPath, [BINS.berry, 'install', '--mode=update-lockfile']],
  };
  const [bin, args] = commands[manager];
  // Асинхронно: поддельный реестр живёт в этом же процессе, синхронный запуск заблокировал бы его.
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${manager} в ${dir}: код ${code}\n${output}`));
      }
    });
  });
}

const LOCKS = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn1: 'yarn.lock', berry: 'yarn.lock' };

server.listen(PORT, '127.0.0.1', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-guard-banned-'));
  const target = path.join(__dirname, '..', 'fixtures', 'banned-package');
  try {
    for (const manager of Object.keys(BINS)) {
      for (const [name, spec] of Object.entries(CASES)) {
        const dir = path.join(work, manager, name);
        const home = path.join(work, `${manager}-${name}-home`);
        fs.mkdirSync(home, { recursive: true });
        project(dir, manager, spec);
        await run(manager, dir, home);
        const out = path.join(target, manager, name);
        fs.rmSync(out, { recursive: true, force: true });
        for (const file of ['package.json', 'pnpm-workspace.yaml', 'packages/app/package.json', LOCKS[manager]]) {
          if (fs.existsSync(path.join(dir, file))) {
            write(path.join(out, file), fs.readFileSync(path.join(dir, file), 'utf8'));
          }
        }
        console.log(`${manager}/${name}: записан ${LOCKS[manager]}`);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    server.close();
  }
});
