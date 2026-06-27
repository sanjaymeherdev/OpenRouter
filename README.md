# Free Model Chat App

Express app using OpenRouter free models, with Redis (caching + rate limiting)
and Neon Postgres (persistent chat history), deployable on Railway.

## Architecture
- `server.js` — Express API: model list, sessions, chat (with tool-calling loop)
- `redisClient.js` — caches the model list (1hr TTL) and rate-limits chat requests (15 req/min per IP)
- `db/` — Postgres schema + connection pool (Neon), stores sessions and messages
- `public/index.html` — minimal frontend, no build step needed

## Local setup

```bash
npm install
cp .env.example .env
# fill in OPENROUTER_API_KEY, REDIS_URL, DATABASE_URL in .env
npm run migrate   # creates tables in Postgres
npm start
```

Visit http://localhost:3000

## Deploying on Railway (single project, 3 services)

1. **Create a new Railway project.**
2. **Add this repo as a service** (Deploy from GitHub, or `railway up` from CLI).
3. **Add Redis**: in the same project, click "+ New" → "Database" → "Add Redis".
   Railway auto-generates a `REDIS_URL`. Reference it in your app service's
   variables as `REDIS_URL=${{Redis.REDIS_URL}}` (Railway's variable reference syntax),
   or copy the value manually from the Redis service's "Variables" tab.
4. **Add Neon Postgres**: Neon is external to Railway (Railway's own Postgres
   plugin also works if you'd rather not use Neon — just swap the connection
   string). Create a project at neon.tech, copy the connection string
   (it includes `?sslmode=require`), and set it as `DATABASE_URL` in your
   app service's variables.
5. **Set `OPENROUTER_API_KEY`** in your app service's variables.
6. **Run the migration once** after first deploy: Railway → your service →
   "Settings" → use a one-off shell (`railway run npm run migrate`) or add
   it temporarily as the start command, then switch back to `node server.js`.
7. Railway sets `PORT` automatically — the app already reads `process.env.PORT`.

## Notes
- Rate limiting is best-effort: if Redis is unreachable, requests are allowed
  through rather than blocking the app (fails open).
- The tool-calling loop supports two demo tools (`calculator`, `get_current_time`).
  Add more by extending the `TOOLS` array and `runTool()` in `server.js`.
- Not all free models support `tools` — check `supported_parameters` from
  `/api/models` (full list) before relying on function calling for a given model.
  The curated `FREE_MODELS` list in `server.js` only includes tool-calling-capable ones.
