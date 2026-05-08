import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_API_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  GCS_BUCKET: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),
  GCS_PUBLIC_BASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_GENERATION_MODEL: z.string().default("gemini-3-flash-preview"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-2"),
  GEMINI_EMBEDDING_DIMENSIONS: z.coerce.number().default(1536),
  RAG_MIN_SIMILARITY: z.coerce.number().default(0.5)
});

export const config = envSchema.parse(process.env);

export function requireConfig<K extends keyof typeof config>(key: K): NonNullable<(typeof config)[K]> {
  const value = config[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value as NonNullable<(typeof config)[K]>;
}
