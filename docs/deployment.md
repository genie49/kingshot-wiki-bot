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

## Railway

Create two services.

API service:

- Root directory: `apps/api`
- Build command: `npm install && npm run build`
- Start command: `npm run start`

Web service:

- Root directory: `apps/web`
- Build command: `npm install && npm run build`
- Start command: `npm run preview`

API variables:

- `PORT`
- `CORS_ORIGIN`
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

Web variables:

- `VITE_API_BASE_URL`

Do not add Supabase or GCS browser keys to the web service. All reads, writes, and uploads should go through the Hono API.
