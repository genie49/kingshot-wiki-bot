# Kingshot Wiki Bot

Kingshot game knowledge base and multimodal RAG chatbot.

The service has two gates:

1. **Ingestion gate**: upload screenshots/images with explanatory text, enrich them with metadata through LangGraph, store images in GCS, and index searchable chunks in Supabase Postgres + pgvector.
2. **Query gate**: answer user questions through a LangChain `create_agent` tool agent that retrieves text chunks and related images, then responds with cited knowledge and image cards.

## Stack

- Web: React + Vite
- API: Hono
- Workflow: LangGraphJS-compatible service layer
- Agent: LangChainJS `createAgent`
- Database: Supabase Postgres + pgvector
- Object storage: Google Cloud Storage
- Models: Gemini generation model and Gemini Embedding 2
- Deploy: Railway

## Repository Layout

```text
apps/
  api/          Hono API service
  web/          React Vite app
supabase/
  schema.sql    pgvector tables, indexes, and RPC search function
  seed.sql      initial Kingshot category taxonomy
docs/
  architecture.md
```

## Quick Start

Copy environment examples:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Run the API:

```bash
cd apps/api
npm install
npm run dev
```

Run the web app:

```bash
cd apps/web
npm install
npm run dev
```

Apply Supabase SQL from `supabase/schema.sql`, then `supabase/seed.sql`.

For Railway and Postgres saver setup, see `docs/deployment.md`.
