# GitHub Releases updates

The packaged Windows Electron application checks the public
[`rwarx/aqvenor` releases](https://github.com/rwarx/aqvenor/releases) through
`electron-updater`. The GitHub account and release assets are controlled by the
project maintainers. Users do not need a GitHub account or token.

## Using updates

Settings shows the installed version, release channel, last check and download
status. A first check runs about ten seconds after startup. Checks repeat every
six hours during a session; failures retry after fifteen minutes. You can also
check manually and retry after an error. A newer installer downloads in the
background, with progress shown in Settings.

Choose the restart/install action after a download completes. Finish or stop
active tasks first, including tasks waiting for tool approval. The updater
refuses a restart while a task is preparing, running, finishing its file/graph
refresh, or waiting for confirmed server cancellation. The close flow handles
unsaved files and flushes pending graph persistence before installation. If that
flow is cancelled or a save fails, the application stays open and the downloaded
update remains available. An ordinary exit does not silently install the update.

Updates are disabled for development (`electron .`) and unsupported platforms.
Versions through `0.3.1-alpha` require one manual installation of a newer version
to receive this updater. The WPF host does not include this update UI.

## Channels and assets

An alpha installation can move to a newer alpha, beta or stable version. A
stable installation receives stable releases. Draft releases are invisible to
the public feed, and the updater rejects downgrades. A manually selected channel
or feed URL cannot be supplied by the renderer.

The release workflow stages only files named by verified installer metadata:

| Asset | Purpose |
| --- | --- |
| `Aqvenor-Setup-<version>.exe` | Windows x64 installer, using the manifest's exact filename |
| `Aqvenor-Setup-<version>.exe.blockmap` | Differential download data |
| `alpha.yml` for an alpha release | Version, installer URL, size and SHA512 |
| `latest.yml` | Electron-builder's GitHub metadata and compatibility fallback |
| `build-source.txt` | Release tag, full source commit SHA and channel |
| `SHA256SUMS.txt` | SHA256 for all the assets above |

Electron-builder's GitHub provider normally writes `latest.yml` even for an
alpha. The collector publishes the same verified metadata as `alpha.yml` so the
updater's named-channel request succeeds. A beta release gets `beta.yml` instead.
GitHub-safe installer names are essential: uploading a filename with spaces can
cause GitHub to rename it differently from the URL in the metadata.

## Cutting a release

1. Commit the implementation, release notes and changelog, with matching versions
   in `Directory.Build.props`, `electron/package.json` and the lockfile.
2. Run the .NET and Electron checks, installer/sidecar smoke checks and the real
   Electron acceptance scenarios. Record the exact tested commit SHA.
3. Create and push the `v<version>` tag at that SHA. The workflow checks out the
   tag's commit and runs build, tests and the sidecar smoke before packaging.
4. The workflow checks the tag again before publication and includes the SHA in
   the assets. It uploads a draft release, verifies all uploaded asset names,
   then makes the release public. Alpha releases are marked as prereleases.

The workflow refuses to replace an existing release, including a draft. Do not
move a published tag or replace a published installer/manifest with a different
build of the same version. Publish a new version for a corrective build. If an
upload fails, its draft stays hidden for inspection; maintainers must resolve the
draft before retrying publication.

The asset collector can also be checked locally after `npm ci` in `electron`:

```powershell
node --test scripts/collect-release-assets.test.cjs
$testedSha = git rev-parse HEAD
node scripts/collect-release-assets.cjs electron/release .tools/release-assets-check v0.3.3-alpha $testedSha
```

The output directory must not already exist. Collection checks metadata version,
installer size/SHA512, blockmap presence, safe asset URLs and the legacy
path/hash before copying. It does not publish anything.

## Integrity and privacy

The updater checks the downloaded installer against the manifest's SHA512.
Release SHA256 sums allow independent integrity checks. These hashes detect
corruption and disagreement with metadata; they do not establish publisher
identity independently of GitHub. Current installers are unsigned, so access to
the repository's release publishing credentials is part of the trust boundary.
Authenticode signing should be added when signing credentials are available.

Update checks and downloads send ordinary HTTP requests to GitHub and its asset
delivery hosts, which see connection metadata such as the IP address. The app
does not attach project paths, files, conversations, provider keys or a GitHub
user token or installation-specific staging identifier. The updater's staging
UUID stays local; Aqvenor overrides its outgoing staging header with a value
common to all installs. Installer downloads are cached locally by
`electron-updater`; normal
application data stays in its existing profile and workspace locations. See
[PRIVACY.md](../PRIVACY.md) for the full data map.
