import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config, requireEnv } from "./config.js";

let client: S3Client | undefined;

function getClient(): S3Client {
  if (client) return client;

  client = new S3Client({
    endpoint: requireEnv("AWS_ENDPOINT_URL", config.s3.endpoint),
    region: requireEnv("AWS_DEFAULT_REGION", config.s3.region),
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID", config.s3.accessKeyId),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY", config.s3.secretAccessKey)
    }
  });

  return client;
}

export function assertStorageConfigured(): void {
  requireEnv("AWS_ENDPOINT_URL", config.s3.endpoint);
  requireEnv("AWS_ACCESS_KEY_ID", config.s3.accessKeyId);
  requireEnv("AWS_SECRET_ACCESS_KEY", config.s3.secretAccessKey);
  requireEnv("AWS_S3_BUCKET_NAME", config.s3.bucketName);
}

export async function putHtmlObject(key: string, html: string): Promise<void> {
  assertStorageConfigured();
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key,
      Body: html,
      ContentType: "text/html; charset=utf-8",
      CacheControl: "no-store"
    })
  );
}

export async function getHtmlObject(key: string): Promise<string> {
  assertStorageConfigured();
  const result = await getClient().send(
    new GetObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key
    })
  );
  return streamToString(result.Body);
}

async function streamToString(stream: unknown): Promise<string> {
  if (!stream || typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
    throw new Error("S3 object body is not readable.");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
