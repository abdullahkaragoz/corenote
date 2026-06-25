# Change Log

## 1.0.3
- When adding a file to a note without an extension, `.md` is now added automatically (no more untyped files).

## 1.0.2
- A note now always opens its main content on click; the internal `note.md` file is no longer shown in the tree.
- Only extra attached files (if any) appear under a note, so single-document notes stay clean.

## 1.0.1
- Right-click a file inside a note to delete just that file (deleting the last file removes the note).
- Single-file notes open with one click.

## 1.0.0
- First public release.
- End-to-end encryption (AES-256-GCM) of both note content and titles.
- Master key (DEK) wrapped by a master password and a recovery key, stored in a keyring gist.
- GitHub Gist storage with cross-device sync via VS Code's built-in GitHub auth.
- Nested folders via `/` in titles; create folders/notes from the toolbar or right-click.
- Bulk **Rename / Move Folder**.
- Commands: Change Master Password, Generate New Recovery Key, Forget Master Password.
- Automatic migration of notes from earlier (plaintext / v1) formats on first unlock.
