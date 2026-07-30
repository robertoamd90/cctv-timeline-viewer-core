# Release Operations

## Repository responsibilities

- `cctv-timeline-viewer-core` owns source, tests, tags and release requests.
- `cctv-timeline-viewer` owns Home Assistant manifests and GHCR publication.
- Never edit a catalog version manually and never add generated catalog files
  back to the core repository.

The core deploy key can write only to the catalog repository. The catalog
workflow token publishes the existing `cctv-viewer` and `cctv-viewer-beta`
packages.

## Version format

- Beta: `X.Y.Z-beta.N`, tagged as `vX.Y.Z-beta.N`.
- Stable: `X.Y.Z`, promoted from a published Beta of the same `X.Y.Z` line.

Prepare the complete `## X.Y.Z` section in `CHANGELOG.md` before creating the
first Beta candidate. Later candidates from the same release line reuse and
refine that section.

## Publish Beta

Start from a green `main` commit:

```bash
git switch main
git pull --ff-only
git tag -a v0.2.0-beta.1 -m "CCTV Viewer 0.2.0 Beta 1"
git push origin v0.2.0-beta.1
```

`Publish Beta` then:

1. runs the complete core CI;
2. writes an immutable request into the catalog;
3. builds and smoke-tests the multi-architecture image from the tagged SHA;
4. verifies `amd64` and `arm64`;
5. publishes the Beta manifest last;
6. records source SHA, image tag and manifest digest in `release-state.json`;
7. creates the GitHub prerelease.

If a run fails, fix the cause and create the next Beta tag. Do not move or
overwrite an existing tag.

## Promote Stable

After validating the selected Beta:

```bash
gh workflow run promote-stable.yml \
  -f candidate=v0.2.0-beta.3 \
  -f version=0.2.0
```

The catalog copies the tested multi-architecture Beta image into the stable
package. It does not rebuild application code. Once the stable manifest is
published, the core workflow creates `v0.2.0` on the candidate commit and
creates the GitHub release.

The workflow is idempotent. Re-running it with the same candidate and version
must resolve to the same source SHA.

## Recovery

- Pending catalog request: run the matching `Publish Beta Request` or
  `Publish Stable Request` workflow manually in the catalog.
- Broken core-to-catalog authentication: run `Verify Catalog Link` in the core.
- Failed candidate: create a new Beta tag after the fix.
- Stable rollback: create a new patch release candidate from the last known
  good commit and promote it as a higher stable version. Never lower the
  catalog version.

## Local Home Assistant package

Generate disposable local build contexts from the core:

```bash
./scripts/package-local-addon.sh
./scripts/package-local-addon.sh stable
./scripts/package-local-addon.sh beta
```

Copy the desired generated directory from `addons/` into the Home Assistant
local apps directory. Generated bundles are ignored by Git and must not be
edited manually.
