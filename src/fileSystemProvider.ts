import * as vscode from 'vscode';
import { GitHubGistApi } from './github';
import { KeyManager } from './keyring';
import { isV2, encryptWithKey, decryptWithKey } from './crypto';

// URI form:  gistnote:/<gistId>/<fileName>
// Example:    gistnote:/abc123/notes.md
export function buildUri(gistId: string, filename: string): vscode.Uri {
  return vscode.Uri.parse(`gistnote:/${gistId}/${encodeURIComponent(filename)}`);
}

function parseUri(uri: vscode.Uri): { gistId: string; filename: string } {
  // path: "/<gistId>/<fileName>"
  const parts = uri.path.replace(/^\//, '').split('/');
  const gistId = parts[0];
  const filename = decodeURIComponent(parts.slice(1).join('/'));
  return { gistId, filename };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Provider that lets us edit notes as if they were local files.
 * - readFile:  fetches content from GitHub
 * - writeFile: PATCHes the change to GitHub (so Ctrl+S = save to the cloud)
 */
export class GistFileSystemProvider implements vscode.FileSystemProvider {
  // A simple cache to avoid repeated network requests within a session.
  private cache = new Map<string, { content: Uint8Array; mtime: number }>();

  constructor(
    private api: GitHubGistApi,
    private keys: KeyManager,
  ) {}

  // Change notifications (this simple version does not watch for external changes).
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const cached = this.cache.get(uri.toString());
    const size = cached ? cached.content.byteLength : (await this.readFile(uri)).byteLength;
    return {
      type: vscode.FileType.File,
      ctime: Date.now(),
      mtime: cached?.mtime ?? Date.now(),
      size,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const cached = this.cache.get(uri.toString());
    if (cached) {
      return cached.content;
    }
    const { gistId, filename } = parseUri(uri);
    const gist = await this.api.getGist(gistId);
    const file = gist.files[filename];
    if (!file) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // For large files GitHub marks content as "truncated"; we fetch the full text from raw_url.
    let raw = file.content ?? '';
    if (file.truncated && file.raw_url) {
      raw = await (await fetch(file.raw_url)).text();
    }

    // If encrypted (v2) decrypt with the DEK; if plaintext (not migrated) use as-is.
    let plaintext: string;
    if (isV2(raw)) {
      const dek = await this.keys.getKey();
      if (!dek) {
        throw vscode.FileSystemError.NoPermissions('Unlock required to open this note.');
      }
      plaintext = decryptWithKey(raw, dek);
    } else {
      plaintext = raw;
    }

    const bytes = encoder.encode(plaintext);
    this.cache.set(uri.toString(), { content: bytes, mtime: Date.now() });
    return bytes;
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { gistId, filename } = parseUri(uri);
    const text = decoder.decode(content);

    // Encrypt with the DEK before saving. If the vault is locked, cancel the save.
    const dek = await this.keys.getKey();
    if (!dek) {
      throw vscode.FileSystemError.NoPermissions(
        'Save cancelled because the vault is locked.',
      );
    }
    const payload = encryptWithKey(text, dek);

    await this.api.updateFile(gistId, filename, payload);
    // Cache the plaintext so reopening does not require decrypting again.
    this.cache.set(uri.toString(), { content, mtime: Date.now() });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  // Force a re-read so the editor does not rely on the cache.
  invalidate(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
  }

  // --- The following complete the interface; rarely called in the single-file flow. ---
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    // gists have no folders; nothing to do
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Deletion is done from the tree view.');
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Renaming is done from the tree view.');
  }
}
