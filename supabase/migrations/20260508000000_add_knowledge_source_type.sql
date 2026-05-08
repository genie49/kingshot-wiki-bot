alter table public.knowledge_items
  add column if not exists source_type text;

update public.knowledge_items
set source_type = 'ai'
where source_type is null
  or source_type not in ('ai', 'swalove');

alter table public.knowledge_items
  alter column source_type set default 'ai',
  alter column source_type set not null;

alter table public.knowledge_items
  drop constraint if exists knowledge_items_source_type_check;

alter table public.knowledge_items
  add constraint knowledge_items_source_type_check
  check (source_type in ('ai', 'swalove'));

create index if not exists knowledge_items_created_at_idx
  on public.knowledge_items(created_at desc);
