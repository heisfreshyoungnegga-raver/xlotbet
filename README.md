# XLOTBET

XLOTBET is a sports betting and casino front end for Ghana, rebranded from an
owner-confirmed site capture, together with a full betting-platform backend.

**Live preview:** https://xlotbet.vercel.app

## Structure

- `site/` — the deployed preview front end (the main XLOTBET app: sportsbook,
  live betting, casino, help and news landing pages). This is the exact code
  serving the live preview above. It is a Vue-based static app captured from a
  rendered site, so it ships as HTML/CSS/JS/SVG files rather than a source
  project with a build step.
- `backend/` — the PrimeStake/Oddaroa engine, copied in full: user, admin and
  super-admin APIs (auth, matches with API-Football + ESPN feeds, bets with
  booking codes and cashout, wallet, ShinobiPay + Flutterwave payments, casino
  games, commissions, support chat). Entry point `backend/server.js`; database
  schema in `backend/db/`; deployment configs in `backend/railway.json` and
  `backend/vercel.json`. It runs against the Neon Postgres project named
  `xlotbet` (connection string and provider keys are supplied as environment
  variables at deploy time — none are stored in this repo).

## Status

This is a **static preview**. The front end is live, and the backend code and
database exist, but the two are **not yet wired together**: login, betting and
deposits on the live site are inactive until the UI-to-backend adapter wiring
is done. Do not treat the live preview as a working betting platform yet.

## What is NOT in this repo

Binary site images cannot travel the connector push route used to create this
repository (text/UTF-8 only), so they were excluded:

- **152 binary files, 1,061,603 bytes total** — PNG/JPG/GIF/WebP artwork, team
  avatars and icons, the favicon (`.ico`) and one webfont (`.woff`) from the
  preview package.

They live with the full preview package locally (`~/workspace/xlotbet/preview`,
242 files) and are served as part of the live Vercel deployment. The complete
original build (1,631 files) is in `~/workspace/xlotbet/site/` locally, with
packages `xlotbet-preview.zip` (242 files) and `xlotbet-site.zip` (full build)
beside it.
