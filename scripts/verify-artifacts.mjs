import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const require = createRequire(import.meta.url);

/**
 * Reads the relative JavaScript dependency graph emitted by the bundler.
 * Both ESM imports and CJS requires must be followed because the pure entry
 * points can delegate most of their implementation to format-specific chunks.
 */
const collectGraph = async (entry, visited = new Set()) => {
  if (visited.has(entry)) return '';
  visited.add(entry);
  const source = await readFile(entry, 'utf8');
  const dependencies = [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g,
    ),
  ];
  const children = await Promise.all(
    dependencies.map((match) =>
      collectGraph(resolve(dirname(entry), match[1]), visited),
    ),
  );
  return [source, ...children].join('\n');
};

const pureEsm = await collectGraph(resolve(dist, 'pure.mjs'));
const pureCjs = await collectGraph(resolve(dist, 'pure.cjs'));
for (const source of [pureEsm, pureCjs]) {
  assert.doesNotMatch(
    source,
    /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"](?:axios|loglevel)['"]/,
  );
}

const emittedFiles = await readdir(dist, { recursive: true });
const emittedJavaScript = await Promise.all(
  emittedFiles
    .filter((file) => /\.(?:cjs|mjs)$/.test(file))
    .map((file) => readFile(resolve(dist, file), 'utf8')),
);
for (const source of emittedJavaScript) {
  assert.doesNotMatch(source, /process\.env/);
}

const pure = await import(pathToFileURL(resolve(dist, 'pure.mjs')).href);
const rootModule = await import(pathToFileURL(resolve(dist, 'index.mjs')).href);
const pureRequired = require(resolve(dist, 'pure.cjs'));
const rootRequired = require(resolve(dist, 'index.cjs'));

for (const module of [pure, rootModule, pureRequired, rootRequired]) {
  assert.equal(typeof module.createApiFactoryPure, 'function');
}
assert.equal(typeof rootModule.createApiStore, 'function');
assert.equal(typeof rootRequired.createApiStore, 'function');

const declarations = await readFile(resolve(dist, 'pure.d.mts'), 'utf8');
assert.match(declarations, /RetryDecider/);
assert.match(declarations, /AxiosErrorMapperOptions/);

/**
 * Exercise the packed directory shape outside the repository hierarchy. Only
 * React and Zustand are linked into the fixture, so accidental pure-entry
 * imports of optional adapters fail instead of resolving from this checkout.
 */
const fixture = await mkdtemp(join(tmpdir(), 'factora-pure-'));
try {
  const fixtureModules = join(fixture, 'node_modules');
  const fixturePackage = join(fixtureModules, 'factora');
  await mkdir(fixturePackage, { recursive: true });
  await cp(dist, join(fixturePackage, 'dist'), { recursive: true });
  await cp(resolve(root, 'package.json'), join(fixturePackage, 'package.json'));
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await Promise.all(
    ['react', 'zustand'].map((dependency) =>
      symlink(
        resolve(root, 'node_modules', dependency),
        join(fixtureModules, dependency),
        'dir',
      ),
    ),
  );

  const executions = [
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { createApiFactoryPure } from 'factora/pure'; if (typeof createApiFactoryPure !== 'function') process.exit(1);",
      ],
      { cwd: fixture, encoding: 'utf8' },
    ),
    spawnSync(
      process.execPath,
      [
        '--input-type=commonjs',
        '--eval',
        "const { createApiFactoryPure } = require('factora/pure'); if (typeof createApiFactoryPure !== 'function') process.exit(1);",
      ],
      { cwd: fixture, encoding: 'utf8' },
    ),
  ];
  for (const execution of executions) {
    assert.equal(
      execution.status,
      0,
      execution.error?.message ||
        execution.stderr ||
        execution.stdout ||
        'isolated pure import failed',
    );
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}

process.stdout.write('Artifact verification passed.\n');
