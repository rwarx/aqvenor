'use strict';

// GitHub uploads must use the names recorded in electron-builder's manifest.
// Uploading "Aqvenor Setup ...exe" directly lets GitHub replace spaces with dots,
// while electron-builder records "Aqvenor-Setup-...exe": the updater then gets 404.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const requireElectron = createRequire(path.resolve(__dirname, '../electron/package.json'));
const yaml = requireElectron('js-yaml');
const semver = requireElectron('semver');

async function digest(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

async function collectReleaseAssets({ input, output, tag, sha }) {
  const version = tag?.startsWith('v') ? tag.slice(1) : null;
  if (!version || !semver.valid(version)) throw new Error('A valid v-prefixed release tag is required.');
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('The full tested commit SHA is required.');
  const channel = String(semver.prerelease(version)?.[0] ?? 'latest');
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error('The update channel must be a safe named channel.');
  input = path.resolve(input);
  output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error(`Output already exists; refusing to replace it: ${output}`);

  // electron-builder's GitHub provider normally writes latest.yml for prereleases.
  // Publish an identical named-channel alias so the first alpha.yml request works.
  const manifestPath = [path.join(input, `${channel}.yml`), path.join(input, 'latest.yml')]
    .find(file => fs.existsSync(file));
  if (!manifestPath) throw new Error(`Missing update metadata (${channel}.yml or latest.yml).`);
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = yaml.load(manifestText);
  if (manifest?.version !== version) throw new Error(`Update metadata version does not match ${tag}.`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Update metadata has no installer files.');

  const candidates = fs.readdirSync(input, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.exe') && !/unins/i.test(entry.name))
    .map(entry => path.join(input, entry.name));
  const copies = new Map();
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(file.url ?? '')) {
      throw new Error('Installer URL must be a GitHub-safe basename ending in .exe.');
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 ||
        !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 ?? '')) {
      throw new Error(`Missing valid size or SHA512 for ${file.url}.`);
    }
    if (copies.has(file.url)) throw new Error(`Duplicate installer URL: ${file.url}`);
    const matches = [];
    for (const candidate of candidates) {
      if (fs.statSync(candidate).size === file.size &&
          await digest(candidate, 'sha512', 'base64') === file.sha512) matches.push(candidate);
    }
    if (matches.length !== 1) throw new Error(`Expected exactly one installer matching ${file.url}; found ${matches.length}.`);
    const installer = matches[0];
    const blockmap = `${installer}.blockmap`;
    if (!fs.existsSync(blockmap) || fs.statSync(blockmap).size === 0) {
      throw new Error(`Missing non-empty blockmap for ${file.url}.`);
    }
    copies.set(file.url, installer);
    copies.set(`${file.url}.blockmap`, blockmap);
  }
  const legacy = manifest.files.find(file => file.url === manifest.path);
  if (!legacy || legacy.sha512 !== manifest.sha512) throw new Error('Legacy update path/hash disagree with files metadata.');

  // All inputs are verified before staging any file. A fresh output directory
  // also keeps an interrupted or older build from silently contributing assets.
  fs.mkdirSync(output);
  for (const [name, source] of copies) fs.copyFileSync(source, path.join(output, name), fs.constants.COPYFILE_EXCL);
  for (const name of new Set([`${channel}.yml`, 'latest.yml'])) {
    fs.writeFileSync(path.join(output, name), manifestText, { flag: 'wx' });
  }
  fs.writeFileSync(path.join(output, 'build-source.txt'), `tag=${tag}\ncommit=${sha.toLowerCase()}\nchannel=${channel}\n`, { flag: 'wx' });
  const sums = [];
  for (const name of fs.readdirSync(output).sort()) {
    sums.push(`${await digest(path.join(output, name), 'sha256', 'hex')}  ${name}`);
  }
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, { flag: 'wx' });
  return fs.readdirSync(output).sort();
}

module.exports = { collectReleaseAssets };
if (require.main === module) {
  const [input, output, tag, sha] = process.argv.slice(2);
  if (!input || !output || !tag || !sha || process.argv.length !== 6) {
    console.error('Usage: node scripts/collect-release-assets.cjs INPUT OUTPUT TAG FULL_COMMIT_SHA');
    process.exitCode = 1;
  } else {
    collectReleaseAssets({ input, output, tag, sha })
      .then(files => console.log(files.join('\n')))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
