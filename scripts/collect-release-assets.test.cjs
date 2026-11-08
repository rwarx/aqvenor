'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectReleaseAssets } = require('./collect-release-assets.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqvenor-release-assets-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aqvenor-release-assets-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(input);
  const installerName = 'Aqvenor Setup 0.3.2-alpha.exe';
  const installer = Buffer.from('release installer content');
  fs.writeFileSync(path.join(input, installerName), installer);
  fs.writeFileSync(path.join(input, `${installerName}.blockmap`), 'release blockmap');
  const url = 'Aqvenor-Setup-0.3.2-alpha.exe';
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  const manifest = {
    version: '0.3.2-alpha',
    files: [{ url, sha512, size: installer.length }],
    path: url,
    sha512,
  };
  // JSON is valid YAML and makes intentional corruptions unambiguous in tests.
  const writeManifest = () => fs.writeFileSync(path.join(input, 'latest.yml'), JSON.stringify(manifest));
  writeManifest();
  return { input, output, tag: 'v0.3.2-alpha', sha: 'a'.repeat(40), manifest, writeManifest, installerName };
}

test('stage GitHub-safe installer names, both alpha manifests and matching checksums', async t => {
  const f = fixture(t);
  // A stale local package must not be attached to this release.
  fs.writeFileSync(path.join(f.input, 'Aqvenor Setup 0.3.1-alpha.exe'), 'older installer');
  const files = await collectReleaseAssets(f);
  assert.deepEqual(files, [
    'Aqvenor-Setup-0.3.2-alpha.exe',
    'Aqvenor-Setup-0.3.2-alpha.exe.blockmap',
    'SHA256SUMS.txt', 'alpha.yml', 'build-source.txt', 'latest.yml',
  ]);
  assert.equal(fs.readFileSync(path.join(f.output, 'alpha.yml'), 'utf8'),
    fs.readFileSync(path.join(f.output, 'latest.yml'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(f.output, 'build-source.txt'), 'utf8'),
    `tag=v0.3.2-alpha\ncommit=${f.sha}\nchannel=alpha\n`);
  const sums = fs.readFileSync(path.join(f.output, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(sums.length, files.length - 1);
  for (const sum of sums) {
    const [expected, name] = sum.split('  ');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.output, name))).digest('hex');
    assert.equal(actual, expected);
  }
});

test('reject metadata from another release before staging output', async t => {
  const f = fixture(t);
  f.manifest.version = '0.3.1-alpha';
  f.writeManifest();
  await assert.rejects(collectReleaseAssets(f), /version does not match/);
  assert.equal(fs.existsSync(f.output), false);
});

test('reject a corrupt installer even when its size still matches', async t => {
  const f = fixture(t);
  const installer = path.join(f.input, f.installerName);
  const bytes = fs.readFileSync(installer);
  bytes[0] ^= 1;
  fs.writeFileSync(installer, bytes);
  await assert.rejects(collectReleaseAssets(f), /matching.*found 0/);
  assert.equal(fs.existsSync(f.output), false);
});

test('require the blockmap used for differential downloads', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.input, `${f.installerName}.blockmap`));
  await assert.rejects(collectReleaseAssets(f), /blockmap/);
  assert.equal(fs.existsSync(f.output), false);
});

test('reject installer paths that escape the release asset directory', async t => {
  const f = fixture(t);
  f.manifest.files[0].url = '../outside.exe';
  f.writeManifest();
  await assert.rejects(collectReleaseAssets(f), /safe basename/);
  assert.equal(fs.existsSync(f.output), false);
});

test('reject legacy path metadata that would download another installer', async t => {
  const f = fixture(t);
  f.manifest.path = 'other.exe';
  f.writeManifest();
  await assert.rejects(collectReleaseAssets(f), /Legacy update path/);
  assert.equal(fs.existsSync(f.output), false);
});

test('refuse to overwrite already collected assets', async t => {
  const f = fixture(t);
  await collectReleaseAssets(f);
  const source = fs.readFileSync(path.join(f.output, 'build-source.txt'), 'utf8');
  await assert.rejects(collectReleaseAssets({ ...f, sha: 'b'.repeat(40) }), /Output already exists/);
  assert.equal(fs.readFileSync(path.join(f.output, 'build-source.txt'), 'utf8'), source);
});
