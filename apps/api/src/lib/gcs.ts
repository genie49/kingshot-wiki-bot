import { Storage } from "@google-cloud/storage";
import { config, requireConfig } from "../config.js";

let storage: Storage | undefined;

function createStorageClient() {
  if (storage) return storage;

  storage = new Storage({
    projectId: config.GOOGLE_CLOUD_PROJECT || undefined,
    credentials: config.GOOGLE_APPLICATION_CREDENTIALS_JSON
      ? JSON.parse(config.GOOGLE_APPLICATION_CREDENTIALS_JSON)
      : undefined
  });

  return storage;
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
}

export type UploadedGcsAsset = {
  url: string;
  mimeType: string;
  filename: string;
  size: number;
};

export async function uploadImageToGcs(file: File): Promise<UploadedGcsAsset> {
  const bucketName = requireConfig("GCS_BUCKET");
  const bucket = createStorageClient().bucket(bucketName);
  const bytes = Buffer.from(await file.arrayBuffer());
  const objectName = `knowledge-assets/${Date.now()}-${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
  const object = bucket.file(objectName);
  const mimeType = file.type || "application/octet-stream";

  await object.save(bytes, {
    contentType: mimeType,
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=31536000, immutable"
    }
  });

  const publicBaseUrl = config.GCS_PUBLIC_BASE_URL || `https://storage.googleapis.com/${bucketName}`;

  return {
    url: `${publicBaseUrl}/${objectName}`,
    mimeType,
    filename: file.name,
    size: file.size
  };
}
