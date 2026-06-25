import * as vscode from 'vscode';
import { GitHubGistApi, Gist } from './github';
import { buildUri } from './fileSystemProvider';
import { KeyManager } from './keyring';
import { decryptTitleOrRaw } from './crypto';

// Title separator: "Work/ProjectA/Notes" -> note "Notes" under Work > ProjectA.
const SEP = '/';

// The note's main content file. It is hidden from the tree; clicking a note opens it.
const MAIN_FILE = 'note.md';

// The main content file of a gist (note.md if present, otherwise the first file).
function mainFileOf(gist: Gist): string {
  const files = Object.keys(gist.files);
  return files.includes(MAIN_FILE) ? MAIN_FILE : files[0];
}

// Any additional files attached to a note (everything except the main file).
function extraFilesOf(gist: Gist): string[] {
  const main = mainFileOf(gist);
  return Object.keys(gist.files).filter((f) => f !== main);
}

// Represents a note: which gist and the label it shows in the sidebar.
interface NoteRef {
  gist: Gist;
  label: string;
}

// Virtual folder (view only; has no real counterpart on GitHub).
interface FolderData {
  name: string;
  path: string; // full path from the root, e.g. "Work/ProjectA"
  subfolders: Map<string, FolderData>;
  notes: NoteRef[];
}

function newFolder(name: string, path: string): FolderData {
  return { name, path, subfolders: new Map(), notes: [] };
}

// Build a folder tree from the gist list using the "/" separator in titles.
// Titles may be encrypted with the DEK; they are decrypted here.
function buildForest(gists: Gist[], dek: Buffer): FolderData {
  const root = newFolder('', '');
  for (const g of gists) {
    const desc = decryptTitleOrRaw(g.description ?? '', dek).trim();
    const segs = desc ? desc.split(SEP).map((s) => s.trim()).filter(Boolean) : [];

    let label: string;
    let folderSegs: string[];
    if (segs.length === 0) {
      label = Object.keys(g.files)[0] ?? '(untitled note)';
      folderSegs = [];
    } else {
      label = segs[segs.length - 1];
      folderSegs = segs.slice(0, -1);
    }

    let cur = root;
    for (const f of folderSegs) {
      if (!cur.subfolders.has(f)) {
        const path = cur.path ? `${cur.path}${SEP}${f}` : f;
        cur.subfolders.set(f, newFolder(f, path));
      }
      cur = cur.subfolders.get(f)!;
    }
    cur.notes.push({ gist: g, label });
  }
  return root;
}

// A node in the tree: a folder, a gist (note), or a file within a gist.
export class NoteNode extends vscode.TreeItem {
  constructor(
    public readonly kind: 'folder' | 'gist' | 'file',
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly gist?: Gist,
    public readonly filename?: string,
    public readonly folder?: FolderData,
  ) {
    super(label, collapsibleState);

    if (kind === 'folder') {
      this.contextValue = 'folder';
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (kind === 'gist') {
      this.contextValue = 'gist';
      this.iconPath = new vscode.ThemeIcon('notebook');
      this.tooltip = new vscode.MarkdownString(
        `**${label}**\n\nLast updated: ${new Date(
          gist!.updated_at,
        ).toLocaleString('en-US')}`,
      );
      // Clicking a note always opens its main content; the main file is never listed as a child.
      const main = mainFileOf(gist!);
      if (main) {
        this.command = {
          command: 'gistNotes.openFile',
          title: 'Open',
          arguments: [gist!.id, main],
        };
      }
    } else {
      this.contextValue = 'file';
      this.iconPath = vscode.ThemeIcon.File;
      this.resourceUri = buildUri(gist!.id, filename!);
      this.command = {
        command: 'gistNotes.openFile',
        title: 'Open',
        arguments: [gist!.id, filename!],
      };
    }
  }
}

export class NotesTreeProvider implements vscode.TreeDataProvider<NoteNode> {
  private changeEmitter = new vscode.EventEmitter<NoteNode | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private forest: FolderData | undefined;

  constructor(
    private api: GitHubGistApi,
    private keys: KeyManager,
  ) {}

  refresh(): void {
    this.forest = undefined;
    this.changeEmitter.fire();
  }

  getTreeItem(element: NoteNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NoteNode): Promise<NoteNode[]> {
    // Top level: fetch gists and build the folder tree.
    if (!element) {
      if (!(await this.api.isSignedIn())) {
        return [];
      }
      const dek = await this.keys.getKey();
      if (!dek) {
        return []; // not unlocked
      }
      const gists = (await this.api.listGists()).filter((g) => !this.keys.isKeyringGist(g));
      this.forest = buildForest(gists, dek);
      return this.renderFolder(this.forest);
    }

    // Folder node: subfolders + the notes inside it.
    if (element.kind === 'folder' && element.folder) {
      return this.renderFolder(element.folder);
    }

    // A note's children are only its extra attached files; the main file (note.md) is hidden.
    if (element.kind === 'gist') {
      return extraFilesOf(element.gist!).map(
        (fn) =>
          new NoteNode('file', fn, vscode.TreeItemCollapsibleState.None, element.gist, fn),
      );
    }

    return [];
  }

  // Produce a folder's children: subfolders first (alphabetical), then notes.
  private renderFolder(folder: FolderData): NoteNode[] {
    const folders = [...folder.subfolders.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'tr'),
    );
    const folderNodes = folders.map(
      (f) =>
        new NoteNode(
          'folder',
          f.name,
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          undefined,
          f,
        ),
    );

    const notes = [...folder.notes].sort((a, b) =>
      b.gist.updated_at.localeCompare(a.gist.updated_at),
    );
    const noteNodes = notes.map((n) => {
      // Expandable only when the note has extra attached files (beyond the hidden main file).
      const hasExtras = extraFilesOf(n.gist).length > 0;
      const state = hasExtras
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      return new NoteNode('gist', n.label, state, n.gist);
    });

    return [...folderNodes, ...noteNodes];
  }
}
