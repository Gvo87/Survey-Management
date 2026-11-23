/**
 * Malware scanning for uploaded files. Nothing is downloadable until a scan says it's clean.
 *
 * - `clamav`: streams the file to clamd over TCP with the INSTREAM command. Required in production.
 * - `disabled`: development only. Marks files clean without scanning, and says so in the scan detail.
 */
import { Socket } from 'node:net';

export interface ScanResult {
  infected: boolean;
  /** Signature name when infected; scanner and version otherwise. */
  detail: string;
}

export interface MalwareScanner {
  name: string;
  scan(body: Buffer): Promise<ScanResult>;
}

export function createClamAvScanner(host: string, port: number, timeoutMs = 60_000): MalwareScanner {
  return {
    name: 'clamav',
    scan: (body) =>
      new Promise<ScanResult>((resolve, reject) => {
        const socket = new Socket();
        let reply = '';
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('clamd timed out')));
        socket.on('error', reject);
        socket.on('data', (chunk) => (reply += chunk.toString('utf8')));
        socket.on('close', () => {
          // "stream: OK" or "stream: Eicar-Signature FOUND" (null-terminated with the z prefix).
          const text = reply.replace(/\0/g, '').trim();
          if (/FOUND$/.test(text)) resolve({ infected: true, detail: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
          else if (/OK$/.test(text)) resolve({ infected: false, detail: 'clamav' });
          else reject(new Error(`Unexpected clamd reply: ${text.slice(0, 200)}`));
        });
        socket.connect(port, host, () => {
          socket.write('zINSTREAM\0');
          const chunkSize = 64 * 1024;
          for (let offset = 0; offset < body.length; offset += chunkSize) {
            const chunk = body.subarray(offset, offset + chunkSize);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            socket.write(size);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
        });
      }),
  };
}

export const disabledScanner: MalwareScanner = {
  name: 'disabled',
  scan: async () => ({ infected: false, detail: 'not scanned (MALWARE_SCANNER=disabled, development only)' }),
};

/** The industry-standard harmless test string every antivirus detects. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Test double: flags the EICAR test string, like a real scanner would. */
export const fakeScanner: MalwareScanner = {
  name: 'fake',
  scan: async (body) =>
    body.includes(Buffer.from(EICAR)) ? { infected: true, detail: 'Eicar-Test-Signature' } : { infected: false, detail: 'fake' },
};
