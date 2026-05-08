set maintenance_work_mem = '128MB';

drop index if exists public.knowledge_chunks_embedding_idx;

create index knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

analyze public.knowledge_chunks;
