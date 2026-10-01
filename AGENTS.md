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
The app listens on port 3000. It scans the repo directory at runtime, so only initialized git submodules will appear in the browser.

## Initializing Submodules
Submodules are shallow clones. To populate thumbnails for a system:
```bash
git submodule update --init --depth=1 "Nintendo - Nintendo Entertainment System"
```
Initializing all submodules (~120) takes a long time; do it selectively.

## API Endpoints
- `GET /api/systems` — lists all systems with thumbnail counts
- `GET /api/thumbnails?system=X&type=Named_Boxarts&page=1&perPage=60` — paginated file list
- `GET /img/:system/:type/:file` — serves an individual thumbnail image

## Auto-Sync
A background sync script (`sync-submodules.sh`) runs on container startup and every 30 minutes (configurable via `SYNC_INTERVAL` env var in seconds). It runs `git submodule update --remote --depth=1` to pull the latest commits for all initialized submodules.

- `GET /api/sync-status` — returns current sync status, last sync timestamp, and recent log
- `POST /api/sync` — triggers a manual sync

## Notes
- No external credentials or secrets are required.
- No database — all data is read from the filesystem.
- Dependencies: `express` (runtime), `nodemon` (dev hot-reload).
