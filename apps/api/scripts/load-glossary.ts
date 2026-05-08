import { createEmbeddingModel, normalizeEmbeddingDimensions } from "../src/lib/llm.js";
import { createSupabaseServiceClient } from "../src/lib/supabase.js";
import { GlossaryRepository, type GlossaryEntry } from "../src/repositories/glossary.js";

const SOURCE_BASE = "https://kingshotdata.kr";
const NAMESPACES = ["heroes", "buildings", "common", "calc", "guides"] as const;

type Namespace = (typeof NAMESPACES)[number];

type FlatBundle = Record<string, string>;

function flatten(input: unknown, prefix = ""): FlatBundle {
  const out: FlatBundle = {};
  if (input == null) return out;
  if (typeof input === "string") {
    if (prefix) out[prefix] = input;
    return out;
  }
  if (typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out[next] = v;
    } else if (v && typeof v === "object") {
      Object.assign(out, flatten(v, next));
    }
  }
  return out;
}

async function fetchBundle(lang: "ko" | "en", ns: Namespace): Promise<FlatBundle> {
  const url = `${SOURCE_BASE}/i18n/${lang}/${ns}.json`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    console.warn(`[load-glossary] ${lang}/${ns} -> ${res.status}, skipping`);
    return {};
  }
  const text = (await res.text()).replace(/^﻿/, "");
  try {
    return flatten(JSON.parse(text));
  } catch (err) {
    console.warn(`[load-glossary] ${lang}/${ns} JSON parse failed`, err);
    return {};
  }
}

const SKIP_PREFIXES = [
  "nav.",
  "footer.",
  "home.",
  "about.",
  "guides.meta",
  "buildings.meta",
  "heroes.meta",
  "calc.meta"
];
const SKIP_SUBSTRINGS = [
  ".desc",
  ".description",
  ".intro",
  ".body",
  ".source.",
  ".sources.",
  ".unlock.",
  ".tip.",
  ".tips.",
  ".note",
  ".disclaimer",
  ".aria"
];

function shouldSkipKey(key: string) {
  if (SKIP_PREFIXES.some((p) => key.startsWith(p))) return true;
  if (SKIP_SUBSTRINGS.some((s) => key.includes(s))) return true;
  return false;
}

function categorize(key: string): GlossaryEntry["category"] {
  if (key.startsWith("heroes.card.")) return "hero";
  if (key.startsWith("buildings.card.")) return "building";
  if (key.startsWith("heroes.")) return "hero_term";
  if (key.startsWith("buildings.")) return "building_term";
  if (key.startsWith("calc.")) return "calc";
  if (key.startsWith("guides.")) return "guides";
  return "common";
}

function isUsablePair(ko: string, en: string) {
  const k = ko.trim();
  const e = en.trim();
  if (!k || !e) return false;
  if (k === e) return false;
  if (k.length > 80 || e.length > 80) return false;
  if (/[\.\?!。！？]\s*$/.test(k) && /[\.\?!]\s*$/.test(e)) return false;
  return true;
}

async function buildGlossary(): Promise<GlossaryEntry[]> {
  const seen = new Map<string, GlossaryEntry>();
  for (const ns of NAMESPACES) {
    const [ko, en] = await Promise.all([fetchBundle("ko", ns), fetchBundle("en", ns)]);
    for (const [key, koValue] of Object.entries(ko)) {
      const enValue = en[key];
      if (!enValue) continue;
      if (shouldSkipKey(key)) continue;
      if (!isUsablePair(koValue, enValue)) continue;
      const entry: GlossaryEntry = {
        category: categorize(key),
        canonical_ko: koValue.trim(),
        canonical_en: enValue.trim(),
        source_key: key,
        source_url: `${SOURCE_BASE}/i18n/ko/${ns}.json`,
        metadata: { namespace: ns }
      };
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

function embeddingTextFor(entry: GlossaryEntry) {
  return `${entry.canonical_ko} ${entry.canonical_en} ${entry.category}`.trim();
}

async function embedEntries(entries: GlossaryEntry[]): Promise<GlossaryEntry[]> {
  if (entries.length === 0) return entries;
  const embeddings = createEmbeddingModel();
  const batchSize = 50;
  const out: GlossaryEntry[] = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const texts = batch.map(embeddingTextFor);
    const vectors = await embeddings.embedDocuments(texts);
    for (let j = 0; j < batch.length; j += 1) {
      out.push({ ...batch[j], embedding: normalizeEmbeddingDimensions(vectors[j]) });
    }
    console.info(`[load-glossary] embedded ${out.length}/${entries.length}`);
  }
  return out;
}

async function main() {
  console.info(`[load-glossary] fetching ${NAMESPACES.join(", ")} from ${SOURCE_BASE}`);
  const raw = await buildGlossary();
  console.info(`[load-glossary] prepared ${raw.length} pairs`);
  if (raw.length === 0) return;

  const sample = raw.slice(0, 5).map((e) => `${e.category}: ${e.canonical_ko} ↔ ${e.canonical_en}`);
  console.info("[load-glossary] sample:", sample);

  const withEmbeddings = await embedEntries(raw);

  const repo = new GlossaryRepository(createSupabaseServiceClient());
  const chunkSize = 200;
  let total = 0;
  for (let i = 0; i < withEmbeddings.length; i += chunkSize) {
    const chunk = withEmbeddings.slice(i, i + chunkSize);
    const { inserted } = await repo.upsertMany(chunk);
    total += inserted;
    console.info(`[load-glossary] upserted ${total}/${withEmbeddings.length}`);
  }
  console.info(`[load-glossary] done`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
