/**
 * How file questions reach the server. The live survey uploads through the API (after making sure
 * the response exists); the builder preview keeps files in memory and uploads nothing.
 */
import { createContext } from 'react';

export interface FileInfo {
  name: string;
  size: number;
}

export interface Uploader {
  upload(questionKey: string, file: File): Promise<{ fileId: string } & FileInfo>;
  remove(fileId: string): Promise<void>;
  info(fileId: string): FileInfo | undefined;
}

export const UploadContext = createContext<Uploader | null>(null);

/** Preview: nothing leaves the browser. */
export function previewUploader(): Uploader {
  const files = new Map<string, FileInfo>();
  return {
    async upload(_questionKey, file) {
      const fileId = crypto.randomUUID();
      files.set(fileId, { name: file.name, size: file.size });
      return { fileId, name: file.name, size: file.size };
    },
    async remove(fileId) {
      files.delete(fileId);
    },
    info: (fileId) => files.get(fileId),
  };
}
