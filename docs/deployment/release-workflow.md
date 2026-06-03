# Release Workflow

This maintainer guide covers publishing Instatic Docker images.

End users do not need this page to deploy Instatic. They follow [railway.md](railway.md), [vps.md](vps.md), or [docker-image.md](docker-image.md). Maintainers use this page to keep `ghcr.io/corebunch/instatic` release tags aligned with source tags.

---

## TL;DR

Release image tags:

```txt
ghcr.io/corebunch/instatic:latest
ghcr.io/corebunch/instatic:<semver>
```

Release flow:

1. Keep `main` releasable.
2. Tag a version.
3. GitHub Actions builds `Dockerfile`.
4. GitHub Actions pushes the semver image and `latest`.
5. Operators update by pulling the app image and recreating the app container.

## Tag A Release

```sh
git tag v1.0.0
git push origin v1.0.0
```

The release workflow publishes:

```txt
ghcr.io/corebunch/instatic:1.0.0
ghcr.io/corebunch/instatic:latest
```

Release notes should link to:

- [railway.md](railway.md)
- [vps.md](vps.md)
- [docker-image.md](docker-image.md)
- [backup-restore.md](backup-restore.md)

## Operator Update Command

Image-based VPS Compose installs update the app container without touching DB/uploads volumes:

```sh
docker compose -f compose.prod.yml pull app
docker compose -f compose.prod.yml up -d
```

SQLite installs include the SQLite override when running commands:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml pull app
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

## Source Build Testing

When testing a release candidate before publishing GHCR images, build from a source checkout:

```sh
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

Or build and tag an image manually:

```sh
docker build -t ghcr.io/corebunch/instatic:dev .
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:dev docker compose -f compose.prod.yml up -d
```

## GitHub Actions Shape

The release workflow should:

- run tests and build checks
- log in to GitHub Container Registry with `GITHUB_TOKEN`
- build `Dockerfile`
- push a semver tag for `v*` tags
- push `latest` for releases from `main`

## Related

- [deployment/README.md](README.md) — deployment overview
- [docker-image.md](docker-image.md) — runtime image contract
- `Dockerfile` — image build
- `compose.prod.yml` — production image consumer
