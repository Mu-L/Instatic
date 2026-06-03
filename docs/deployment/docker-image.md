# Generic Docker Image

This guide covers the production Docker image outside the bundled VPS Compose files.

The image contains the built admin UI, Bun server, public renderer, CMS API routes, migrations, and runtime dependencies. It does not run Vite or install packages at container startup.

---

## TL;DR

Run the image with:

- `PORT` set to the platform's HTTP port
- `DATABASE_URL` pointing at SQLite or Postgres
- `UPLOADS_DIR` mounted on persistent storage
- `STATIC_DIR=/app/dist`

Use one persistent mount root when the platform only supports one app volume:

```txt
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
```

## Build Locally

```sh
docker build -t instatic:local .
```

## Published Image

If you have access to a published image, pull it:

```sh
docker pull ghcr.io/corebunch/instatic:latest
```

Pin a version for predictable upgrades:

```sh
docker pull ghcr.io/corebunch/instatic:1.0.0
```

## Run With SQLite

Use this mode when the host can attach a persistent volume to the app container.

```sh
docker volume create instatic-storage

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATABASE_URL="sqlite:/app/storage/data/cms.db" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/storage/uploads \
  -v instatic-storage:/app/storage \
  --restart unless-stopped \
  instatic:local
```

The single volume stores both the SQLite database and uploaded media.

## Run With External Postgres

Use this mode when Postgres is provided by the host or by a separate managed database service.

```sh
docker volume create instatic-storage

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATABASE_URL="postgres://user:password@host:5432/instatic" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/storage/uploads \
  -v instatic-storage:/app/storage \
  --restart unless-stopped \
  instatic:local
```

The app volume is still required in Postgres mode because uploads, fonts, plugin packs, and published disk artefacts live under `UPLOADS_DIR`.

Replace `instatic:local` with `ghcr.io/corebunch/instatic:<tag>` when deploying from a published image.

## Required Runtime Variables

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | Yes | `sqlite:...`, `file:...`, `postgres://...`, or `postgresql://...` |
| `UPLOADS_DIR` | Yes for durable media | Persistent upload directory |
| `STATIC_DIR` | Yes in Docker | `/app/dist` |
| `PORT` | Platform-dependent | HTTP listen port; defaults to `3001` |

Managed platforms usually inject `PORT`. Do not hard-code a different listen port unless the platform asks for a fixed target port.

## Health Check

```sh
curl http://localhost:3001/health
```

Expected response:

```json
{"status":"ok","ts":1234567890}
```

## Related

- [deployment/README.md](README.md) — deployment overview
- [railway.md](railway.md) — Railway template variables
- [vps.md](vps.md) — Docker Compose install
- [backup-restore.md](backup-restore.md) — backing up DB and uploads
- `Dockerfile` — production image definition
- `server/config.ts` — runtime env parsing
