export interface ServiceConfig {
  port: number;
  databaseUrl?: string;
  bootstrapApiKey?: string;
  publicBaseUrl?: string;
  maxHtmlBytes: number;
  s3: S3Config;
}

export interface S3Config {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucketName?: string;
  region: string;
  forcePathStyle: boolean;
}

export const config: ServiceConfig = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  bootstrapApiKey: process.env.PLANLINK_BOOTSTRAP_API_KEY,
  publicBaseUrl: process.env.PLANLINK_PUBLIC_BASE_URL,
  maxHtmlBytes: Number(process.env.MAX_HTML_BYTES || 512 * 1024),
  s3: {
    endpoint: process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME,
    region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "auto",
    forcePathStyle: (process.env.AWS_S3_FORCE_PATH_STYLE || "true") !== "false"
  }
};

export function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
