# Kingshot Wiki Bot Architecture

## Product Shape

This is a private/admin-editable Kingshot wiki plus a multimodal RAG assistant. The highest leverage part is ingestion quality: clean category selection, strong summaries, OCR/vision text, and stable embeddings make query answers much better.

All application data access goes through the Hono API. The web app must not connect to Supabase or GCS directly or ship Supabase/GCS credentials. Hono owns Supabase service-role access, GCS uploads, RAG reads, ingestion writes, and future auth/authorization checks.

## Ingestion Gate

Input:

- One or more images
- Human explanation text
- Optional source note

LangGraph flow:

1. Hono receives uploaded image files from the web app and uploads them to GCS.
2. Extract OCR and image captions.
3. Classify into the fixed category taxonomy.
4. Generate title, two-sentence summary, tags, and embedding text.
5. Chunk summary/body/OCR/captions.
6. Embed chunks with Gemini Embedding 2.
7. Store item, assets, and chunks in Supabase.
8. Mark low-confidence items as `needs_review`.

Categories are fixed at first to avoid taxonomy drift. The LLM may suggest missing taxonomy, but it should not create categories automatically.

## Query Gate

The query API receives the full current chat transcript from the web app on every request. The server does not persist chat history or use a checkpointer; the browser owns the active conversation state.

The non-streaming query API uses a LangChainJS `createAgent` with narrow tools:

- `semantic_search`: vector search over knowledge chunks.
- `get_knowledge_item`: fetch full item details.
- `get_related_images`: fetch related GCS image URLs.
- `list_categories`: help with scoped questions.

The final response returns:

- Answer text
- Source item summaries
- Related image URLs

## Initial Taxonomy

- Beginner Guide
- Heroes
- Troops and Formations
- Buildings
- Research
- Governor Gear
- Governor Charms
- Pets
- Resources and Items
- Alliance
- Alliance Territory
- Events
- Combat and PvP
- KvK and Castle Battle
- Shop and Spending
- Gift Codes
- Calculators and Upgrade Costs
- FAQ and Tips

## Data Model

Core entities:

- `categories`
- `knowledge_items`
- `knowledge_assets`
- `knowledge_chunks`

Use `knowledge_chunks.embedding vector(1536)` by default so Supabase `pgvector` can use an `ivfflat` index. Gemini Embedding 2 can support larger dimensions, but `ivfflat` cannot index vectors above 2000 dimensions. Keep the schema and embedding client output dimension aligned.

## Deployment Notes

Railway can host `apps/api` and `apps/web` as separate services. Supabase and GCS remain managed external services.

Recommended Railway variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GCS_BUCKET`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `GEMINI_API_KEY`
- `GEMINI_GENERATION_MODEL`
- `GEMINI_EMBEDDING_MODEL`
