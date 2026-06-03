# Railway Deployment

This guide defines the Railway template configuration for Instatic.

Railway is the simplest managed target for Instatic because it can run the production Dockerfile, inject a public HTTP port, attach a persistent volume, and provision Postgres in the same project.

---

## TL;DR

| Template | Database | App volume | `DATABASE_URL` |
|---|---|---|---|
| SQLite | SQLite file in the app volume | `/app/storage` | `sqlite:/app/storage/data/cms.db` |
| Postgres | Railway Postgres service | `/app/storage` for uploads only | `${{Postgres.DATABASE_URL}}` |

Both templates use:

```txt
PORT=8080
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
```

Configure the app service health check path as `/health`. If Railway asks which port the app listens on when generating a public URL, use the same value as `PORT`.

## App Service

Use the root repository as the service source and build with the root `Dockerfile`. The image already runs:

```sh
bun run server/index.ts
```

Do not add a separate migration command. `server/index.ts` creates the DB client from `DATABASE_URL` and runs the matching migrations before the HTTP server starts.

Recommended service settings:

| Setting | Value |
|---|---|
| Source | GitHub repository or published Docker image |
| Dockerfile path | `Dockerfile` |
| Public networking | HTTP enabled |
| Target port | `8080` |
| Healthcheck path | `/health` |
| Volume mount path | `/app/storage` |

Railway volumes mount at runtime, not build time. Instatic only writes runtime data there, so the root Docker build stays unchanged.

## SQLite Template

Use SQLite for the simplest one-service Railway install. Attach one volume to the app service:

```txt
Mount path: /app/storage
```

Set app variables:

```txt
PORT=8080
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
```

The SQLite adapter creates the parent directory for `/app/storage/data/cms.db` on boot. Media writes create subdirectories under `/app/storage/uploads` as needed.

## Postgres Template

Use Postgres when the site has several admin users, when you want database backups through the DB service, or when you might run more than one app instance later.

Template services:

| Service | Source | Persistent data |
|---|---|---|
| App | Instatic Dockerfile/image | `/app/storage/uploads` on the app volume |
| Postgres | Railway PostgreSQL template | Postgres service volume |

Attach one volume to the app service:

```txt
Mount path: /app/storage
```

Set app variables:

```txt
PORT=8080
DATABASE_URL=${{Postgres.DATABASE_URL}}
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
```

The `Postgres` prefix is the Railway service name. If the database service is renamed, update the reference to match, for example `${{instatic-postgres.DATABASE_URL}}`.

Use `DATABASE_URL`, not `DATABASE_PUBLIC_URL`, for app-to-database traffic inside the same Railway project. `DATABASE_PUBLIC_URL` goes through Railway's public TCP proxy and is for external clients such as local admin tools.

## Backups

Back up both data stores:

- SQLite template: back up the app volume mounted at `/app/storage`; it contains both `data/cms.db` and `uploads/`.
- Postgres template: back up the Postgres service volume/database and the app volume mounted at `/app/storage`; the app volume contains uploaded media, fonts, plugin packages, and published artefacts.

Railway volume backups apply to mounted volumes. For Postgres, use Railway's database backup/PITR tooling when enabled, or add a `pg_dump` backup service for off-platform dumps.

## Troubleshooting

| Symptom | Check |
|---|---|
| Public URL shows service unavailable | `PORT` and the public target port must match. The template uses `8080`. |
| Deploy health check fails | Healthcheck path must be `/health`; the app must listen on `PORT`. |
| SQLite data disappears after redeploy | `DATABASE_URL` must point under the mounted volume, e.g. `/app/storage/data/cms.db`. |
| Uploaded files disappear after redeploy | `UPLOADS_DIR` must point under the mounted volume, e.g. `/app/storage/uploads`. |
| Postgres app cannot connect | `DATABASE_URL` must reference the Postgres service's internal `DATABASE_URL`, not a copied local URL. |

## Related

- [deployment/README.md](README.md) — deployment overview
- [backup-restore.md](backup-restore.md) — backup rules
- `server/config.ts` — runtime env parsing
- `server/db/index.ts` — database URL detection
- `Dockerfile` — production image
- Railway docs: [PostgreSQL](https://docs.railway.com/databases/postgresql/), [Volumes](https://docs.railway.com/develop/volumes), [Healthchecks](https://docs.railway.com/reference/healthchecks)
