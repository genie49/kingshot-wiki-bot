import { ChatOpenAI } from "@langchain/openai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { config, requireConfig } from "../config.js";

export function createChatModel() {
  return new ChatOpenAI({
    apiKey: requireConfig("OPENROUTER_API_KEY"),
    model: config.OPENROUTER_GENERATION_MODEL,
    temperature: 0.2,
    configuration: {
      baseURL: config.OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": config.OPENROUTER_HTTP_REFERER,
        "X-Title": config.OPENROUTER_APP_TITLE
      }
    }
  });
}

export function createEmbeddingModel() {
  return new GoogleGenerativeAIEmbeddings({
    apiKey: requireConfig("GEMINI_API_KEY"),
    model: config.GEMINI_EMBEDDING_MODEL
  });
}

export function normalizeEmbeddingDimensions(embedding: number[]) {
  const dimensions = config.GEMINI_EMBEDDING_DIMENSIONS;
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);
  return [...embedding, ...Array.from({ length: dimensions - embedding.length }, () => 0)];
}
