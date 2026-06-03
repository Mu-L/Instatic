# Deployment

This index maps supported deployment targets to the files, variables, and persistence rules they need.

Instatic is one Bun server packaged by the root `Dockerfile`. The server reads runtime configuration from `server/config.ts`: `PORT`, `DATABASE_URL`, `UPLOADS_DIR`, and `STATIC_DIR`. Database migrations run automatically on boot in `server/index.ts`.

---

## TL;DR

| Target | Use when | Database | Persistent storage | Docs |
|---|---|---|---|---|
| Railway SQLite template | Fastest managed install for a single site | SQLite file | One Railway app volume mounted at `/app/storage` | [railway.md](railway.md) |
| Railway Postgres template | Managed install for teams or horizontal scale later | Railway Postgres | App volume for uploads, Postgres service volume for DB | [railway.md](railway.md) |
| VPS Docker Compose | Self-hosted server, full control | SQLite or bundled Postgres | Docker named volumes | [vps.md](vps.md) |
| Generic Docker host | Any platform that runs the Dockerfile/image | SQLite or external Postgres | A mounted directory/volume for DB/uploads | [docker-image.md](docker-image.md) |
| VPS HTTPS | Public domain on a VPS | Unchanged | Caddy cert volume plus app volumes | [tls-caddy.md](tls-caddy.md) |

Back up both the database and uploaded media. See [backup-restore.md](backup-restore.md).

## Runtime Contract

Every deployment target configures the same process:

```txt
PORT          HTTP port the Bun server listens on
DATABASE_URL  sqlite:/path/to/cms.db, file:/path/to/cms.db, postgres://..., or postgresql://...
UPLOADS_DIR   directory for media, plugin packs, fonts, and published disk artefacts
STATIC_DIR    built admin SPA directory; /app/dist in the Docker image
```

The Docker image sets:

```txt
PORT=3001
STATIC_DIR=/app/dist
UPLOADS_DIR=/app/uploads
```

Managed platforms often override `PORT`. That is fine; the server uses `process.env.PORT`.

## Image Availability

Source builds are the current portable install path:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build
```

When an operator has access to a published image, set `INSTATIC_IMAGE` and omit `compose.build.yml`. The maintainer release target is `ghcr.io/corebunch/instatic`, documented in [release-workflow.md](release-workflow.md).

## Database Choice

The database engine is selected only by `DATABASE_URL`:

| URL shape | Engine |
|---|---|
| `sqlite:/path/to/cms.db` | SQLite |
| `file:/path/to/cms.db` | SQLite |
| `/path/to/cms.db` | SQLite |
| `postgres://...` | Postgres |
| `postgresql://...` | Postgres |

SQLite is the default for single-site installs. Postgres is for multiple simultaneous admin writers, more than one app container, or operators who already want managed Postgres.

## Persistence Rules

`UPLOADS_DIR` is required for durable media regardless of the database engine. It stores:

- uploaded media originals and variants
- uploaded fonts
- plugin packages and module packs
- published static artefacts under `published/current`

SQLite installs also need the SQLite database file on persistent storage. On platforms with only one app volume, put both the SQLite file and uploads under the same mounted root.

## Docs Inventory

| File | Role |
|---|---|
| [railway.md](railway.md) | Railway templates for SQLite and Postgres |
| [vps.md](vps.md) | Docker Compose on a VPS, both SQLite and Postgres |
| [docker-image.md](docker-image.md) | Generic Docker image contract and `docker run` examples |
| [tls-caddy.md](tls-caddy.md) | Caddy TLS overlay for VPS Compose installs |
| [backup-restore.md](backup-restore.md) | Database and uploads backup/restore |
| [release-workflow.md](release-workflow.md) | Maintainer image publishing workflow |

## Related

- `server/config.ts` — runtime env parsing
- `server/db/index.ts` — database URL detection
- `server/index.ts` — migrations, media storage, and server boot
- `Dockerfile` — production image contract
- `compose.prod.yml`, `compose.sqlite.yml`, `compose.tls.yml` — VPS Compose files
