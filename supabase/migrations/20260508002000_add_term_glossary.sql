create extension if not exists vector;

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

create index if not exists term_glossary_canonical_ko_idx
  on public.term_glossary (lower(canonical_ko));

create index if not exists term_glossary_canonical_en_idx
  on public.term_glossary (lower(canonical_en));

create index if not exists term_glossary_category_idx
  on public.term_glossary (category);

create index if not exists term_glossary_embedding_idx
  on public.term_glossary using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create or replace function public.term_glossary_set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists term_glossary_set_updated_at on public.term_glossary;
create trigger term_glossary_set_updated_at
before update on public.term_glossary
for each row execute function public.term_glossary_set_updated_at();

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
