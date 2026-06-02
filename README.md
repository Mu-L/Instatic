# Instatic

Self-hosted CMS with an integrated visual editor. The app serves the public website, admin editor, CMS API, published pages, and uploaded media from one Bun server. Supports **Postgres** and **SQLite** — selected by `DATABASE_URL`.

The project is open source under the MIT license. Source is published at [github.com/corebunch/instatic](https://github.com/corebunch/instatic), and production images are published as `ghcr.io/corebunch/instatic`.

## Local Development

Install dependencies:

```sh
bun install
```

Start with zero external dependencies (SQLite, no Docker required):

```sh
bun run dev
```

Or run the full stack in containers (production-like Dockerfile + Postgres + persistent volumes):

```sh
docker compose -f compose.prod.yml -f compose.build.yml up --build
```

Open:

```txt
http://localhost:3001/admin
```

The first visit creates the site and admin account.

`bun run dev` defaults to SQLite at `.tmp/dev.db`. Set `DATABASE_URL=postgres://...` to use Postgres instead.

To try the app locally in production mode (built admin SPA from `./dist`, no Vite, no `--watch`, same SQLite dev DB):

```sh
bun run start
```

Builds the admin SPA, then starts the server on `http://localhost:3001`. If port 3001 is already held by a dev server (or a previous `bun run start`), you'll be prompted whether to kill the holder and take over. `bun run dev` uses the same prompt for ports 3001 and 5173.

## Production Deployment

The default self-host install is **SQLite + one container** — recommended for most users (single sites, hobby and small-business installs, single-author or small editorial teams). No `.env` file required:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

If you have a multi-author editorial team, need horizontal app scale-out, or already operate Postgres, run with bundled Postgres instead (two containers). Postgres mode requires setting `POSTGRES_PASSWORD`:

```sh
cp .env.production.example .env       # set POSTGRES_PASSWORD to a real secret
docker compose -f compose.prod.yml up -d
```

To put HTTPS in front (Caddy + Let's Encrypt, auto-provisioned), layer `compose.tls.yml` on top of either DB mode and set `DOMAIN` in `.env`:

```sh
# SQLite + TLS (default)
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml up -d
# Postgres + TLS
docker compose -f compose.prod.yml -f compose.tls.yml up -d
```

Without `compose.tls.yml`, the app is reachable on `http://server-ip:3001/admin`. With it, only Caddy is exposed (ports 80 / 443) and the cert is auto-provisioned for `${DOMAIN}` on the first request.

Engine selection is one env var (`DATABASE_URL`) — same image, same code. Docker is purely packaging; both engines also run with `bun run server/index.ts` directly on the host. See [docs/deployment/README.md](docs/deployment/README.md) for the full decision matrix.

Production servers should normally pull the published Docker image configured in `.env.production.example`. Developers can build locally from source with:

```sh
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

For managed hosts, deploy the Dockerfile from GitHub or a published image and connect it to managed Postgres with `DATABASE_URL`.

Deployment docs:

- [Production Docker image](docs/deployment/docker-image.md)
- [VPS Docker Compose](docs/deployment/vps-compose.md)
- [SQLite deployment](docs/deployment/sqlite-install.md)
- [HTTPS via Caddy](docs/deployment/tls-caddy.md)
- [Backup and restore](docs/deployment/backup-restore.md)
- [Release and image publishing workflow](docs/deployment/release-workflow.md)

## Required Production Data

Back up both:

- Database — Postgres (`pg_dump`) or SQLite (copy the `.db` file, or use [Litestream](https://litestream.io) for continuous replication)
- uploads directory or uploads volume

Do not run `docker compose -f compose.prod.yml down -v` unless you intentionally want to delete CMS data.

## Useful Commands

```sh
bun run build
bun test
docker build -t instatic:local .
docker compose -f compose.prod.yml pull app
curl http://localhost:3001/health
```
