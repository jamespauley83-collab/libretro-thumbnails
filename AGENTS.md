# Base44 Dev Environment

## Overview
This is the `libretro-thumbnails` repository — a collection of RetroArch thumbnail images organized as git submodules by console system. It is **not** a runnable application by itself. A thumbnail browser web app was added (Node.js + Express) to browse the images.

## Architecture
- **Backend**: `server.js` — Express server serving a REST API and static frontend
- **Frontend**: `public/index.html`, `public/app.js`, `public/style.css` — vanilla JS SPA
- **Data**: The repo's own directories (git submodules), each containing `Named_Boxarts/`, `Named_Titles/`, `Named_Snaps/`, `Named_Logos/` subdirectories with `.png` files

## Running
```bash
docker compose -f docker-compose.base44.yml up -d --build
```
The app listens on port 3000. It lists declared systems immediately; downloaded images are scanned from the repo at runtime. Downloads are explicit and show a storage warning; no systems are initialized automatically by default.

## Initializing Submodules
Submodules are shallow clones. To populate thumbnails for a system:
```bash
git submodule update --init --depth=1 "Nintendo - Nintendo Entertainment System"
```
Initializing all submodules (~120) takes a long time; do it selectively.

## API Endpoints
- `GET /api/systems` — lists declared/downloaded systems with thumbnail counts and a `downloadable` flag
- `GET /api/thumbnails?system=X&type=Named_Boxarts&page=1&perPage=60` — paginated file list
- `GET /img/:system/:type/:file` — serves an individual thumbnail image

## Auto-Sync
The server owns one serialized sync manager (`submodule-sync.js`). Startup and
periodic jobs update only initialized systems. New collections require an explicit
selected-system request. Updates run every `SYNC_INTERVAL` seconds (default
1800; 0 disables the interval). Git jobs are limited to ten minutes and failures
remain visible. Do not add a separate background sync loop.

- `GET /api/sync-status` — returns current status, last successful sync, and error/log
- `POST /api/sync` — returns 202 and starts an asynchronous sync; JSON `{system}`
  initializes/updates exactly that declared system; omission updates loaded ones only
- `sh sync-submodules.sh [system]` — asks the running server to perform that same sync

## Testing

Run `npm test`, `npm run check`, and `git diff --check`. Tests include isolated
real-Git initialization fixtures and the existing image path/symlink regression
suite; they do not download public thumbnail repositories.

## Notes
- No external credentials or secrets are required.
- No database — all data is read from the filesystem.
- Dependencies: `express` (runtime), `nodemon` (dev hot-reload).
