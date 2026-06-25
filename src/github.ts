import * as vscode from 'vscode';

// Types returned by GitHub's gist API (the fields we need)
export interface GistFile {
  filename: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  raw_url?: string;
}

export interface Gist {
  id: string;
  description: string | null;
  html_url: string;
  updated_at: string;
  files: Record<string, GistFile>;
}

const API = 'https://api.github.com';

/**
 * A thin wrapper around GitHub Gist operations.
 * Authentication is fully delegated to VS Code's built-in 'github' provider;
 * we do not write our own OAuth flow. The 'gist' scope is enough for read/write.
 */
export class GitHubGistApi {
  // Get the access token from the current session.
  // If createIfNone=true, the sign-in dialog is shown to the user.
  private async getToken(createIfNone: boolean): Promise<string | undefined> {
    const session = await vscode.authentication.getSession('github', ['gist'], {
      createIfNone,
    });
    return session?.accessToken;
  }

  // Is there a session? (silent check, no dialog)
  async isSignedIn(): Promise<boolean> {
    const token = await this.getToken(false);
    return !!token;
  }

  // Open the sign-in dialog.
  async signIn(): Promise<boolean> {
    const token = await this.getToken(true);
    return !!token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    interactiveSignIn = false,
  ): Promise<T> {
    const token = await this.getToken(interactiveSignIn);
    if (!token) {
      throw new Error('No GitHub session found. Please sign in first.');
    }

    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) {
      return undefined as T; // e.g. delete returns no content
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error (${res.status}): ${text}`);
    }

    return (await res.json()) as T;
  }

  // List all of the user's gists (collects every page).
  async listGists(): Promise<Gist[]> {
    const all: Gist[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<Gist[]>('GET', `/gists?per_page=100&page=${page}`, undefined, true);
      all.push(...batch);
      if (batch.length < 100) {
        break;
      }
    }
    return all;
  }

  // Fetch a single gist with full content (including file contents).
  async getGist(id: string): Promise<Gist> {
    return this.request<Gist>('GET', `/gists/${id}`);
  }

  // Create a new gist (= a new note).
  async createGist(description: string, filename: string, content: string): Promise<Gist> {
    return this.request<Gist>('POST', '/gists', {
      description,
      public: false,
      files: { [filename]: { content: content || ' ' } },
    });
  }

  // Update a file inside a gist (the call behind a Ctrl+S save).
  async updateFile(id: string, filename: string, content: string): Promise<Gist> {
    return this.request<Gist>('PATCH', `/gists/${id}`, {
      files: { [filename]: { content: content || ' ' } },
    });
  }

  // Change the description (the note title).
  async updateDescription(id: string, description: string): Promise<Gist> {
    return this.request<Gist>('PATCH', `/gists/${id}`, { description });
  }

  // Gist'e yeni bir dosya ekler.
  async addFile(id: string, filename: string, content: string): Promise<Gist> {
    return this.request<Gist>('PATCH', `/gists/${id}`, {
      files: { [filename]: { content: content || ' ' } },
    });
  }

  // Delete a single file inside a gist (GitHub deletes a file when its value is null).
  async deleteFile(id: string, filename: string): Promise<Gist> {
    return this.request<Gist>('PATCH', `/gists/${id}`, {
      files: { [filename]: null },
    });
  }

  // Delete the whole gist (the note).
  async deleteGist(id: string): Promise<void> {
    await this.request<void>('DELETE', `/gists/${id}`);
  }
}
