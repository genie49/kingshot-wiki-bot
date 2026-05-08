create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  parent_id uuid references public.categories(id) on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text not null,
  body text not null,
  category_id uuid references public.categories(id) on delete set null,
  tags text[] not null default '{}',
  source_type text not null default 'ai' check (source_type in ('ai', 'swalove')),
  source_note text,
  status text not null default 'draft' check (status in ('draft', 'published', 'needs_review')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_assets (
  id uuid primary key default gen_random_uuid(),
  knowledge_item_id uuid not null references public.knowledge_items(id) on delete cascade,
  gcs_url text not null,
  mime_type text not null,
  ocr_text text,
  vision_caption text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_item_id uuid not null references public.knowledge_items(id) on delete cascade,
  chunk_text text not null,
  chunk_type text not null check (chunk_type in ('summary', 'body', 'ocr', 'image_caption')),
  embedding vector(1536) not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.term_glossary (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  canonical_ko text not null,
  canonical_en text not null,
  source_key text,
  source_url text,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists term_glossary_source_key_uq
  on public.term_glossary (source_key)
  where source_key is not null;
create index if not exists term_glossary_canonical_ko_idx on public.term_glossary (lower(canonical_ko));
create index if not exists term_glossary_canonical_en_idx on public.term_glossary (lower(canonical_en));
create index if not exists term_glossary_category_idx on public.term_glossary (category);
create index if not exists term_glossary_embedding_idx
  on public.term_glossary using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists categories_parent_id_idx on public.categories(parent_id);
create index if not exists knowledge_items_category_id_idx on public.knowledge_items(category_id);
create index if not exists knowledge_items_status_idx on public.knowledge_items(status);
create index if not exists knowledge_items_created_at_idx on public.knowledge_items(created_at desc);
create index if not exists knowledge_assets_item_id_idx on public.knowledge_assets(knowledge_item_id);
create index if not exists knowledge_chunks_item_id_idx on public.knowledge_chunks(knowledge_item_id);
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create or replace function public.match_glossary(
  query_embedding vector(1536),
  match_count integer default 8
)
returns table (
  id uuid,
  category text,
  canonical_ko text,
  canonical_en text,
  source_key text,
  similarity double precision
)
language sql
stable
as $$
  select
    tg.id,
    tg.category,
    tg.canonical_ko,
    tg.canonical_en,
    tg.source_key,
    1 - (tg.embedding <=> query_embedding) as similarity
  from public.term_glossary tg
  where tg.embedding is not null
  order by tg.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count integer default 6
)
returns table (
  chunk_id uuid,
  knowledge_item_id uuid,
  title text,
  summary text,
  chunk_text text,
  similarity double precision
)
language sql
stable
as $$
  select
    kc.id as chunk_id,
    ki.id as knowledge_item_id,
    ki.title,
    ki.summary,
    kc.chunk_text,
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_items ki on ki.id = kc.knowledge_item_id
  where ki.status = 'published'
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
