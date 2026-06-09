# Instatic

A self-hosted visual CMS for people who want ownership without giving up a modern editing experience.

Build visually. Manage real content. Publish fast, lightweight websites with clean HTML and CSS instead of bloated page-builder output. Host it yourself, extend it with plugins, and keep your site portable.

[Quick start](#quick-start) · [Deploy](#deploying-instatic) · [Docs](docs/README.md) · [Plugins](docs/features/plugin-system.md)

Instatic is open source under the MIT license.

## Highlights

- A canvas-style visual editor for building pages directly.
- Responsive editing with real mobile, tablet, and desktop previews.
- A focused content editor for posts and collections, plus live mode to edit inside the final site design.
- A built-in CodeMirror editor for CSS, scripts, site files, and advanced customization.
- Reusable visual components, templates, loops, forms, and media workflows.
- Lightweight published sites with clean HTML and CSS, built the way a senior developer would ship by hand.
- Self-hosted, portable, MIT licensed, and not tied to a SaaS account.
- SQLite for simple installs, Postgres when your team or infrastructure needs it.

## Why Instatic?

Instatic sits somewhere between a visual site builder, a real CMS, and a developer-grade publishing system.

If you are coming from **WordPress**, you get the familiar idea of owning your site and managing real content, but without plugin sprawl, theme archaeology, or page-builder markup soup.

If you are coming from **Webflow** or **Framer**, you get a modern visual canvas and polished authoring workflow, but your site stays self-hosted, portable, and open source.

If you like designing in **Figma**, the editor should feel natural: canvas-first, visual, responsive, and direct. But instead of handing designs off to rebuild elsewhere, you publish from the same system.

If you have fought with **Gutenberg**, Instatic gives you a calmer writing flow: write focused content, switch to live mode, and edit inside the actual design of your site without block-editor friction.

## What You Can Build

Instatic is built for real websites, not just landing-page demos:

- Marketing sites and small-business websites.
- Blogs, docs, changelogs, and content-heavy sites.
- Portfolios, directories, resource libraries, and product catalogs.
- Client sites that need roles, media, forms, reusable sections, and a clean handoff.
- Plugin-powered sites that need custom admin pages, modules, data, jobs, or integrations.

## The Editor

The site editor is a visual canvas, not a form pretending to be a website builder.

- Build pages from modules like containers, text, images, buttons, video, lists, loops, forms, and visual component refs.
- Edit in design mode with multiple breakpoint frames side by side, or live mode with a single real-size editable page.
- Create reusable Visual Components with typed parameters and slots.
- Use templates for shared headers, footers, layouts, and post-type designs.
- Bind loops to content entries, pages, media, or plugin-provided data sources.
- Add CSS classes, ambient selectors, responsive conditions, and site-level files when visual controls are not enough.

The Content workspace is for writing and publishing structured content. It has a focused writing surface for posts and collections, plus live mode so authors can see and edit content inside the actual site design.

The Data workspace is for custom tables, schemas, raw rows, imports, exports, and form submissions. Pages, posts, components, custom collections, and arbitrary data all share one content model.

The Media workspace gives you folders, reusable assets, metadata, upload queues, smart folders, replacement workflows, and plugin-backed storage adapters.

## Clean Output

Instatic is a visual CMS, but it does not publish like a bloated page builder.

Public pages are emitted as semantic HTML with compact CSS. The visitor-facing site stays lightweight, inspectable, and easy to host. The admin app, editor runtime, React, Vite, and builder internals stay out of your public pages.

For static pages, Instatic bakes HTML files to disk at publish time and swaps them atomically. Dynamic parts are detected automatically and rendered through a small runtime only where the page actually needs it.

The result is fast-loading websites that do not feel trapped inside the tool that made them.

## Content, Forms, And Imports

Instatic is not only a page canvas.

- Manage posts, pages, custom collections, and arbitrary structured tables.
- Build CMS-native forms visually and store submissions in your own data tables.
- Import pasted HTML into editable page nodes.
- Import static-site bundles with pages, CSS, images, fonts, scripts, and conflicts reviewed before commit.
- Export and import full CMS bundles to move a site between instances.
- Keep draft content separate from published content, so unpublished edits do not leak to visitors.

## Plugins

Plugins are first-class, but they are not trusted blindly.

Instatic plugins ship as zip packages with a `plugin.json` manifest. Server entrypoints and canvas module packs run inside a QuickJS-WASM sandbox with no host file system, no environment variables, and no network unless the site owner grants it. Plugins can add routes, storage, hooks, loop sources, scheduled jobs, modules, admin pages, media adapters, and frontend assets through the SDK.

Start here:

- [Plugin system](docs/features/plugin-system.md)
- [Template plugin](examples/plugins/template/README.md)

## Quick Start

You need [Bun](https://bun.sh). Docker is optional for local development.

Install dependencies:

```sh
bun install
```

Start Instatic with SQLite and no external services:

```sh
bun run dev
```

Open the editor:

```txt
http://localhost:5173
```

The first visit creates the site and owner account.

`bun run dev` starts two processes:

- Vite on `http://localhost:5173` for the admin UI.
- The CMS server on `http://localhost:3001` for the API and public routes.

To run locally in production mode, with the built admin app served by the Bun server:

```sh
bun run start
```

Then open:

```txt
http://localhost:3001/admin
```

## Deploying Instatic

The default self-host install is **SQLite + one container**. That is the right starting point for most single sites, hobby projects, small businesses, portfolios, blogs, and small editorial teams.

Download the release bundle from the latest GitHub Release, unpack it on the server, then run:

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Pin a version for predictable upgrades:

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:0.0.1 docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Use **Postgres** when you have a multi-author editorial team, need horizontal app scale-out, or already operate Postgres:

```sh
cp .env.production.example .env
# Set POSTGRES_PASSWORD and INSTATIC_SECRET_KEY in .env.
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml up -d
```

To put HTTPS in front with Caddy and Let's Encrypt, add the TLS override and set `DOMAIN` in `.env`:

```sh
# SQLite + TLS
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml up -d

# Postgres + TLS
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml -f compose.tls.yml up -d
```

Without `compose.tls.yml`, the app is reachable at `http://server-ip:3001/admin`. With it, only Caddy is exposed on ports 80 and 443, and certificates are provisioned automatically.

Deployment docs:

- [Deployment overview](docs/deployment/README.md)
- [VPS / Docker Compose](docs/deployment/vps.md)
- [Railway](docs/deployment/railway.md)
- [Render](docs/deployment/render.md)
- [Generic Docker image](docs/deployment/docker-image.md)
- [HTTPS via Caddy](docs/deployment/tls-caddy.md)
- [Backup and restore](docs/deployment/backup-restore.md)
- [Release workflow](docs/deployment/release-workflow.md)

## Backups

Back up both pieces of production data:

- The database: Postgres (`pg_dump`) or SQLite (`cms.db`, ideally with a proper snapshot or continuous replication).
- The uploads directory or uploads volume.

Do not run `docker compose -f compose.prod.yml down -v` unless you intentionally want to delete CMS data.

See [Backup and restore](docs/deployment/backup-restore.md).

## For Developers

Instatic is one Bun server with a Vite-built React admin app and a publishing pipeline that emits clean public pages.

At a glance:

- Runtime: Bun.
- Language: TypeScript.
- Admin app: React 19, Vite, Zustand, Mutative, CodeMirror, Tiptap, dnd-kit.
- Server: `Bun.serve` with a hand-written router.
- Database: SQLite or Postgres selected by `DATABASE_URL`.
- Validation: TypeBox at every untyped boundary.
- Publishing: semantic HTML, compact CSS bundles, static artefacts where possible, dynamic holes where needed.
- Plugins: QuickJS-WASM sandbox, owner-approved permissions, SDK surface.

Start with:

- [Docs index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Editor](docs/editor.md)
- [Server](docs/server.md)
- [Publisher](docs/features/publisher.md)
- [Plugin system](docs/features/plugin-system.md)

Useful commands:

```sh
bun run build
bun test
bun run lint
docker build -t instatic:local .
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build
curl http://localhost:3001/health
```

## Project Status

Instatic is early and moving quickly. The core editing, content, publishing, deployment, and plugin foundations are in place, but APIs and workflows may still change before a stable 1.0.

That is also the point: the project is still young enough to keep the architecture clean, remove bad ideas, and build the CMS we actually want to use.

## Thanks

Instatic's interface uses [Pixelarticons](https://pixelarticons.com/) by Gerrit Halfmann. A special thanks to Gerrit for making such a distinctive icon set and for kindly allowing it to be used in this open-source project.

## License

MIT. See [LICENSE](LICENSE).
