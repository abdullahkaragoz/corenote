import * as vscode from 'vscode';
import { GitHubGistApi } from './github';
import { GistFileSystemProvider, buildUri } from './fileSystemProvider';
import { NotesTreeProvider, NoteNode } from './notesTree';
import { KeyManager } from './keyring';
import { encryptWithKey, decryptTitleOrRaw } from './crypto';

const SEP = '/';

// Titles are encrypted, so we store the primary file under a fixed, non-revealing name.
const NOTE_FILE = 'note.md';

export function activate(context: vscode.ExtensionContext) {
  const api = new GitHubGistApi();
  const keys = new KeyManager(context.secrets, api);
  const fs = new GistFileSystemProvider(api, keys);
  const tree = new NotesTreeProvider(api, keys);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('gistnote', fs, { isCaseSensitive: true }),
  );
  context.subscriptions.push(vscode.window.registerTreeDataProvider('gistNotes.tree', tree));

  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('gistNotes.openFile', async (gistId: string, filename: string) => {
    const uri = buildUri(gistId, filename);
    fs.invalidate(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  reg('gistNotes.signIn', async () => {
    const ok = await api.signIn();
    if (ok) {
      await keys.getKey(); // unlock / set up right after signing in
      tree.refresh();
    }
  });

  reg('gistNotes.refresh', () => tree.refresh());

  reg('gistNotes.createNote', async () => {
    if (!(await api.isSignedIn()) && !(await api.signIn())) {
      return;
    }
    const dek = await keys.getKey();
    if (!dek) {
      vscode.window.showWarningMessage('Unlock cancelled; note not created.');
      return;
    }
    const title = await vscode.window.showInputBox({
      prompt: 'Note title (use "/" for folders, e.g. Work/Meeting Notes)',
      placeHolder: 'e.g. Work/Meeting Notes',
    });
    if (!title) {
      return;
    }
    // Title and content are written encrypted with the DEK; file name is fixed (no leak).
    const gist = await api.createGist(
      encryptWithKey(title, dek),
      NOTE_FILE,
      encryptWithKey(`# ${title}\n\n`, dek),
    );
    tree.refresh();
    await vscode.commands.executeCommand('gistNotes.openFile', gist.id, NOTE_FILE);
  });

  reg('gistNotes.newNoteInFolder', async (node: NoteNode) => {
    if (!node || node.kind !== 'folder' || !node.folder) {
      return;
    }
    const dek = await keys.getKey();
    if (!dek) {
      return;
    }
    const base = node.folder.path;
    const title = await vscode.window.showInputBox({
      prompt: 'New note in this folder (add more "/" for subfolders)',
      value: `${base}/`,
      valueSelection: [base.length + 1, base.length + 1],
      placeHolder: `${base}/My Note`,
    });
    if (!title || !title.replace(/\/+$/, '').trim()) {
      return;
    }
    const gist = await api.createGist(
      encryptWithKey(title, dek),
      NOTE_FILE,
      encryptWithKey(`# ${title.split(SEP).pop()}\n\n`, dek),
    );
    tree.refresh();
    await vscode.commands.executeCommand('gistNotes.openFile', gist.id, NOTE_FILE);
  });

  reg('gistNotes.newFolder', async (node?: NoteNode) => {
    const dek = await keys.getKey();
    if (!dek) {
      return;
    }
    const base = node && node.kind === 'folder' && node.folder ? node.folder.path : '';
    const name = await vscode.window.showInputBox({
      prompt: base ? `New subfolder inside "${base}" (use "/" for deeper nesting)` : 'New folder name (use "/" for nested folders)',
      placeHolder: 'Projects',
    });
    if (!name || !name.trim()) {
      return;
    }
    const clean = name.trim().replace(/^\/+|\/+$/g, '');
    const folderPath = base ? `${base}${SEP}${clean}` : clean;

    // A folder needs at least one note to exist, so we create its first note.
    const noteTitle = await vscode.window.showInputBox({
      prompt: 'First note in this folder',
      value: `${folderPath}${SEP}`,
      valueSelection: [folderPath.length + 1, folderPath.length + 1],
      placeHolder: `${folderPath}/Untitled`,
    });
    if (noteTitle === undefined) {
      return;
    }
    const finalTitle = noteTitle.replace(/\/+$/, '').trim() ? noteTitle : `${folderPath}${SEP}Untitled`;
    const gist = await api.createGist(
      encryptWithKey(finalTitle, dek),
      NOTE_FILE,
      encryptWithKey(`# ${finalTitle.split(SEP).pop()}\n\n`, dek),
    );
    tree.refresh();
    await vscode.commands.executeCommand('gistNotes.openFile', gist.id, NOTE_FILE);
  });

  reg('gistNotes.deleteFile', async (node: NoteNode) => {
    if (!node || node.kind !== 'file' || !node.gist || !node.filename) {
      return;
    }
    const fileCount = Object.keys(node.gist.files).length;
    if (fileCount <= 1) {
      // A gist must keep at least one file, so deleting the last one removes the whole note.
      const answer = await vscode.window.showWarningMessage(
        `"${node.filename}" is the only file in this note. Delete the entire note?`,
        { modal: true },
        'Delete Note',
      );
      if (answer !== 'Delete Note') {
        return;
      }
      await api.deleteGist(node.gist.id);
      tree.refresh();
      vscode.window.showInformationMessage('Note deleted.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Permanently delete the file "${node.filename}"?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') {
      return;
    }
    await api.deleteFile(node.gist.id, node.filename);
    fs.invalidate(buildUri(node.gist.id, node.filename));
    tree.refresh();
    vscode.window.showInformationMessage('File deleted.');
  });

  reg('gistNotes.deleteNote', async (node: NoteNode) => {
    if (!node?.gist) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Permanently delete "${node.label}"?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') {
      return;
    }
    await api.deleteGist(node.gist.id);
    tree.refresh();
    vscode.window.showInformationMessage('Note deleted.');
  });

  reg('gistNotes.renameNote', async (node: NoteNode) => {
    if (!node?.gist) {
      return;
    }
    const dek = await keys.getKey();
    if (!dek) {
      return;
    }
    const current = decryptTitleOrRaw(node.gist.description ?? '', dek);
    const next = await vscode.window.showInputBox({
      prompt: 'New title (use "/" to move into a folder, e.g. Work/ProjectA/Notes)',
      value: current,
    });
    if (!next) {
      return;
    }
    await api.updateDescription(node.gist.id, encryptWithKey(next, dek));
    tree.refresh();
  });

  reg('gistNotes.renameFolder', async (node: NoteNode) => {
    if (!node || node.kind !== 'folder' || !node.folder) {
      return;
    }
    const dek = await keys.getKey();
    if (!dek) {
      return;
    }
    const currentPath = node.folder.path;
    const oldSegs = currentPath.split(SEP).map((s) => s.trim()).filter(Boolean);

    const next = await vscode.window.showInputBox({
      prompt: 'New folder path (use "/" to move into another folder; leave empty to move notes to the root)',
      value: currentPath,
    });
    if (next === undefined) {
      return;
    }
    const newSegs = next.split(SEP).map((s) => s.trim()).filter(Boolean);

    // Titles are encrypted; decrypt each to match the folder path.
    const gists = (await api.listGists()).filter((g) => !keys.isKeyringGist(g));
    const affected = gists
      .map((g) => ({ g, segs: decryptTitleOrRaw(g.description ?? '', dek).split(SEP).map((s) => s.trim()).filter(Boolean) }))
      .filter(({ segs }) => segs.length > oldSegs.length && oldSegs.every((s, i) => s === segs[i]));

    if (affected.length === 0) {
      vscode.window.showInformationMessage('No notes to move in this folder.');
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Moving folder (${affected.length} notes)` },
      async (progress) => {
        for (let i = 0; i < affected.length; i++) {
          const { g, segs } = affected[i];
          const rest = segs.slice(oldSegs.length);
          const newDesc = [...newSegs, ...rest].join(SEP);
          await api.updateDescription(g.id, encryptWithKey(newDesc, dek));
          progress.report({ increment: 100 / affected.length, message: `${i + 1}/${affected.length}` });
        }
      },
    );

    tree.refresh();
    vscode.window.showInformationMessage(
      `Moved ${affected.length} notes from "${currentPath || '(root)'}" to "${newSegs.join(SEP) || '(root)'}".`,
    );
  });

  reg('gistNotes.addFile', async (node: NoteNode) => {
    if (!node?.gist) {
      return;
    }
    const dek = await keys.getKey();
    if (!dek) {
      return;
    }
    const input = await vscode.window.showInputBox({
      prompt: 'New file name (.md is added automatically if you omit an extension)',
      placeHolder: 'notes  →  notes.md',
    });
    if (!input || !input.trim()) {
      return;
    }
    // Default to a Markdown file when no extension is given.
    let name = input.trim();
    if (!/\.[A-Za-z0-9]+$/.test(name)) {
      name += '.md';
    }
    await api.addFile(node.gist.id, name, encryptWithKey('', dek));
    tree.refresh();
    await vscode.commands.executeCommand('gistNotes.openFile', node.gist.id, name);
  });

  reg('gistNotes.setPassword', async () => {
    await keys.changePassword();
  });

  reg('gistNotes.regenerateRecoveryKey', async () => {
    await keys.regenerateRecoveryKey();
  });

  reg('gistNotes.forgetPassword', async () => {
    await keys.forget();
    vscode.window.showInformationMessage(
      'Master password removed from this device. You will need to enter your password (or recovery key) again to access notes.',
    );
  });

  reg('gistNotes.openInBrowser', async (node: NoteNode) => {
    if (node?.gist) {
      await vscode.env.openExternal(vscode.Uri.parse(node.gist.html_url));
    }
  });
}

export function deactivate() {
  // nothing to clean up
}
