import type { SupabaseClient } from "@supabase/supabase-js";

export type GlossaryCategory =
  | "hero"
  | "hero_term"
  | "building"
  | "building_term"
  | "common"
  | "calc"
  | "guides";

export type GlossaryEntry = {
  id?: string;
  category: GlossaryCategory | string;
  canonical_ko: string;
  canonical_en: string;
  source_key?: string | null;
  source_url?: string | null;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
};

export type GlossaryMatch = {
  id: string;
  category: string;
  canonical_ko: string;
  canonical_en: string;
  source_key: string | null;
  similarity: number;
};

function toVectorLiteral(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

export class GlossaryRepository {
  constructor(private readonly db: SupabaseClient) {}

  async upsertMany(entries: GlossaryEntry[]) {
    if (entries.length === 0) return { inserted: 0 };
    const payload = entries.map((entry) => ({
      ...entry,
      embedding: entry.embedding ? toVectorLiteral(entry.embedding) : null
    }));
    const { error, count } = await this.db
      .from("term_glossary")
      .upsert(payload, { onConflict: "source_key", ignoreDuplicates: false, count: "exact" });
    if (error) throw error;
    return { inserted: count ?? entries.length };
  }

  async listAll(): Promise<GlossaryEntry[]> {
    const { data, error } = await this.db
      .from("term_glossary")
      .select("id, category, canonical_ko, canonical_en, source_key, source_url, metadata");
    if (error) throw error;
    return (data ?? []) as GlossaryEntry[];
  }

  async searchSimilar(queryEmbedding: number[], matchCount = 8): Promise<GlossaryMatch[]> {
    const { data, error } = await this.db.rpc("match_glossary", {
      query_embedding: toVectorLiteral(queryEmbedding),
      match_count: matchCount
    });
    if (error) throw error;
    return (data ?? []) as GlossaryMatch[];
  }
}
