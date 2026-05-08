# Deployment

## Supabase

1. Create a Supabase project.
2. Run `supabase/schema.sql`.
3. Run `supabase/seed.sql`.
4. Copy the project URL and service role key for the API service.

Use `sslmode=require` for hosted Supabase connections.

## Railway

Create two Railway services from the same GitHub repository.

### API project

The Hono API runs as a long-running Node process on Railway. The API is split into:

- `apps/api/src/app.ts`: the Hono app and routes.
- `apps/api/src/server.ts`: Node server entrypoint for Railway and local smoke tests.
- `apps/api/src/index.ts`: Hono app export, kept for portability.

Project settings:

- Root directory: `apps/api`
- Build command: `npm run build`
- Start command: `npm run start`

Railway provides `PORT`; the API binds to `0.0.0.0` and reads that port from env.
The `/query/stream` endpoint streams SSE chat deltas from the Node process.

API environment variables:

- `CORS_ORIGIN`: the deployed web app URL
- `SUPABASE_URL`
- `SUPABASE_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GCS_BUCKET`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `GCS_PUBLIC_BASE_URL`
- `GEMINI_API_KEY` (used only for embeddings)
- `GEMINI_EMBEDDING_MODEL`
- `GEMINI_EMBEDDING_DIMENSIONS`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL` (defaults to `https://openrouter.ai/api/v1`)
- `OPENROUTER_GENERATION_MODEL` (e.g. `deepseek/deepseek-v4-pro`)
- `OPENROUTER_HTTP_REFERER` (sent as the OpenRouter `HTTP-Referer` header)
- `OPENROUTER_APP_TITLE` (sent as the OpenRouter `X-Title` header)
- `RAG_MIN_SIMILARITY`: recommended `0.55` for the current Kingshot corpus

### Web project

Project settings:

- Root directory: `apps/web`
- Build command: `npm run build`
- Start command: `npm run start`

Web environment variables:

- `VITE_API_BASE_URL`: the deployed Railway API URL

Do not add Supabase or GCS browser keys to the web project. All reads, writes,
and uploads should go through the Hono API.

### Local API smoke test

If you need to run the API as a long-running Node process locally:

```bash
npm --workspace apps/api run start:local
```
