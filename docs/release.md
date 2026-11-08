# Tag releases

`.github/workflows/release.yml` builds the desktop packages on GitHub's free
runners and publishes them on the pushed tag's GitHub release. It is the
release path for this repository; it is not the macOS pipeline described in
[releasing.md](releasing.md) and is not gated on CI — the lean
[ci.yml](../.github/workflows/ci.yml) runs targeted unit tests only and does
not gate releases.

## Trigger and version rule

Push a tag whose name is `v<version>` and matches `package.json`'s `version`:

```sh
git tag v1.3.0
git push origin v1.3.0
```

The workflow fails at once when `v` plus `package.json`'s version is not the
tag name, so a tag can never publish an installer built from another version.
Nothing else triggers it: no branch push, no manual dispatch.

## What it builds

| Job | Runner | Output |
| --- | --- | --- |
| `linux` | `ubuntu-latest` | AppImage, deb, `latest-linux.yml`, blockmaps |
| `windows` | `windows-latest` | NSIS `-setup.exe`, zip, `latest.yml`, blockmaps |
| `release` | `ubuntu-latest` | creates or updates the tag's release with every artifact above |

Both build jobs run the repository's own packaging scripts (`pnpm
package:linux`, `pnpm package:win`) with `--publish never`, so electron-builder
only writes into `release/`; the `release` job uploads that directory with the
workflow's `GITHUB_TOKEN` (`gh release create`, or `gh release upload
--clobber` when the release already exists for a re-pushed tag). The job fails
when an installer or an updater feed is missing.

The pnpm store is cached by `actions/setup-node`; pnpm itself comes from
`package.json`'s `packageManager` field (`pnpm@10.33.0`), and Node is the
repository's minimum major, 24.

## macOS

No macOS job. A dmg or zip without a Developer ID signature and notarization
is unusable on current macOS, and those credentials (`MAC_CERT_P12_BASE64`,
`APPLE_API_KEY_P8_BASE64`, …) are not configured for this repository. Build
macOS locally with `pnpm package:mac` when the signing material is available;
see [releasing.md](releasing.md).

## Update feed

`electron-builder.yml` points its `publish` target at this repository
(`Johhny-Xu/multi-agent-hub`), so the `app-update.yml` baked into these
installers and the `latest.yml` / `latest-linux.yml` feeds the release job
uploads beside the artifacts all resolve here: a packaged app checks this
repository's releases for updates. Keep `publish.owner` and `publish.repo`
in `electron-builder.yml` in step with wherever this repository lives.

## Checking the workflow locally

Validate the YAML (catches indentation and quoting mistakes; note that PyYAML
reads the unquoted `on` key as the boolean `True`):

```sh
python3 -c 'import yaml,sys; d=yaml.safe_load(open(".github/workflows/release.yml")); print(sorted(d))'
```

Run the same steps without publishing with [act](https://github.com/nektos/act)
(needs Docker; the run performs real package builds, so expect it to take as
long as CI):

```sh
cat > /tmp/tag-event.json <<'JSON'
{"ref": "refs/tags/v1.3.0"}
JSON
act push -W .github/workflows/release.yml -e /tmp/tag-event.json -n   # list only
act push -W .github/workflows/release.yml -e /tmp/tag-event.json      # full run
```

`-n` stops after act resolves the event and the jobs, which is enough to check
triggers and job wiring. A full local build is the same as the two packaging
commands below; neither uploads anything.

## Reproducing a build locally

```sh
pnpm install --frozen-lockfile
pnpm package:linux        # on Linux: release/*.AppImage, *.deb, latest-linux.yml
pnpm package:win          # on Windows: release/*-setup.exe, *.zip, latest.yml
```

The scripts stage the pinned cloudflared, browser engine, DuckDB and CUA
resources first; all of them are public downloads verified against pins in
`scripts/`, so no secret is needed.

## Token permissions

The workflow declares `permissions: contents: read`; the `release` job alone
raises its own token to `contents: write`, which is what `GITHUB_TOKEN` needs
to create a release and upload assets. If the repository or its organization
sets the default workflow token to read-only, the declaration still raises it
to write unless an organization policy forbids it; in that case allow write
for this workflow in **Settings → Actions → General → Workflow permissions**.

## Pinned actions

Every external action (`actions/checkout`, `actions/setup-node`,
`pnpm/action-setup`, `actions/upload-artifact`, `actions/download-artifact`)
is pinned to a full commit SHA; `scripts/ci-workflow.test.ts`, which the CI
workflow runs, fails when one floats back to a branch-style tag.
