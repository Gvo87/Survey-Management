/**
 * Object storage for uploads and logos. S3 in production (any S3-compatible service locally);
 * an in-memory implementation for tests.
 */
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  ensureBucket(): Promise<void>;
}

export interface S3Settings {
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export function createS3Storage(s: S3Settings): ObjectStorage {
  const client = new S3Client({
    region: s.region,
    ...(s.endpoint ? { endpoint: s.endpoint } : {}),
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  });
  const Bucket = s.bucket;
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    },
    async stream(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return out.Body as Readable;
    },
    async copy(from, to) {
      await client.send(new CopyObjectCommand({ Bucket, Key: to, CopySource: `${Bucket}/${encodeURIComponent(from).replace(/%2F/g, '/')}` }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },
  };
}

export function createMemoryStorage(): ObjectStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const read = (key: string) => {
    const body = objects.get(key);
    if (!body) throw Object.assign(new Error(`No such key: ${key}`), { name: 'NoSuchKey' });
    return body;
  };
  return {
    objects,
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async get(key) {
      return read(key);
    },
    async stream(key) {
      return Readable.from([read(key)]);
    },
    async copy(from, to) {
      objects.set(to, read(from));
    },
    async delete(key) {
      objects.delete(key);
    },
    async ensureBucket() {},
  };
}
