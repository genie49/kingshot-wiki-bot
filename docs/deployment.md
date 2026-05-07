# Deployment

## Supabase

1. Create a Supabase project.
2. Run `supabase/schema.sql`.
3. Run `supabase/seed.sql`.
4. Copy the project URL and service role key for the API service.
5. Copy a direct Postgres connection string for `POSTGRES_CHECKPOINT_URL`.

Use `sslmode=require` for hosted Supabase connections.

## LangGraph Postgres Saver

After setting `POSTGRES_CHECKPOINT_URL`, run this once from `apps/api`:

```bash
npm run setup:checkpointer
```

This creates the checkpoint tables used by LangGraphJS `PostgresSaver`.

## Vercel

Create two Vercel projects from the same GitHub repository.

### API project

The Hono API is serverless-ready and split into:

- `apps/api/src/app.ts`: the Hono app and routes.
- `apps/api/src/index.ts`: serverless entrypoint that default-exports the Hono app.
- `apps/api/src/server.ts`: local/long-running Node entrypoint.

Project settings:

- Framework preset: `Hono`
- Root directory: `apps/api`
- Build command: `npm run build`

Vercel detects `src/index.ts` and turns the Hono routes into Vercel Functions.
Vercel Functions support streaming, so `/query/stream` can stream chat deltas.

API environment variables:

- `CORS_ORIGIN`: the deployed web app URL
- `SUPABASE_URL`
- `SUPABASE_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `POSTGRES_CHECKPOINT_URL`
- `GCS_BUCKET`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `GCS_PUBLIC_BASE_URL`
- `GEMINI_API_KEY`
- `GEMINI_GENERATION_MODEL`
- `GEMINI_EMBEDDING_MODEL`
- `GEMINI_EMBEDDING_DIMENSIONS`
- `RAG_MIN_SIMILARITY`

### Web project

Project settings:

- Framework preset: `Vite`
- Root directory: `apps/web`
- Build command: `npm run build`
- Output directory: `dist`

Web environment variables:

- `VITE_API_BASE_URL`: the deployed Hono API URL

Do not add Supabase or GCS browser keys to the web project. All reads, writes,
and uploads should go through the Hono API.

### Local API smoke test

If you need to run the API as a long-running Node process locally:

```bash
npm --workspace apps/api run start:local
```
