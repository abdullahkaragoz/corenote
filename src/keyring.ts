import * as vscode from 'vscode';
import { GitHubGistApi, Gist } from './github';
import * as cy from './crypto';

const KEYRING_FILE = 'gist-notes-keyring.json';
const KEYRING_DESC = 'gist-notes-keyring (do not delete this gist)';
const PW_SECRET = 'gistNotes.masterPassword';

interface Keyring {
  version: number;
  wraps: {
    password?: cy.Wrapped;
    recovery?: cy.Wrapped;
  };
}

/**
 * Manages the lifecycle of the master Data Encryption Key (DEK):
 * - A random DEK encrypts every note's content and title.
 * - The DEK is "wrapped" separately by the password and by a recovery key,
 *   and stored (only in wrapped form) in a dedicated keyring gist on GitHub.
 * - The password is asked only once per device (kept in SecretStorage).
 */
export class KeyManager {
  private dek: Buffer | undefined;
  private keyringId: string | undefined;

  constructor(
    private secrets: vscode.SecretStorage,
    private api: GitHubGistApi,
  ) {}

  // Is this gist the keyring gist? (so we can hide it from the notes tree)
  isKeyringGist(g: Gist): boolean {
    return KEYRING_FILE in g.files;
  }

  // Returns the in-memory DEK; unlocks or runs first-time setup if needed.
  async getKey(): Promise<Buffer | undefined> {
    if (this.dek) {
      return this.dek;
    }
    const found = await this.findKeyring();
    if (!found) {
      return this.firstTimeSetup();
    }
    return this.unlock(found.data);
  }

  hasKey(): boolean {
    return !!this.dek;
  }

  private async findKeyring(): Promise<{ id: string; data: Keyring } | undefined> {
    const gists = await this.api.listGists();
    const g = gists.find((x) => KEYRING_FILE in x.files);
    if (!g) {
      return undefined;
    }
    this.keyringId = g.id;
    const full = await this.api.getGist(g.id);
    const raw = full.files[KEYRING_FILE]?.content ?? '{}';
    return { id: g.id, data: JSON.parse(raw) as Keyring };
  }

  private async saveKeyring(data: Keyring): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    if (this.keyringId) {
      await this.api.updateFile(this.keyringId, KEYRING_FILE, content);
    } else {
      const g = await this.api.createGist(KEYRING_DESC, KEYRING_FILE, content);
      this.keyringId = g.id;
    }
  }

  // First-time setup: generate DEK + recovery key, create the keyring, migrate old notes.
  private async firstTimeSetup(): Promise<Buffer | undefined> {
    // Reuse a legacy password from an earlier version if present (seamless upgrade).
    let password = await this.secrets.get(PW_SECRET);
    if (!password) {
      const pw = await vscode.window.showInputBox({
        prompt: 'Set a master password for your notes',
        password: true,
        ignoreFocusOut: true,
      });
      if (!pw) {
        return undefined;
      }
      const confirm = await vscode.window.showInputBox({
        prompt: 'Re-enter the password',
        password: true,
        ignoreFocusOut: true,
      });
      if (confirm !== pw) {
        vscode.window.showErrorMessage('Passwords did not match.');
        return undefined;
      }
      password = pw;
    }

    const dek = cy.generateKey();
    const recoveryKey = cy.generateRecoveryKey();
    const keyring: Keyring = {
      version: 1,
      wraps: {
        password: cy.wrapKey(dek, password),
        recovery: cy.wrapKey(dek, recoveryKey),
      },
    };
    await this.saveKeyring(keyring);
    await this.secrets.store(PW_SECRET, password);
    this.dek = dek;

    // Migrate existing (plaintext / v1) notes to the new format.
    await this.migrateExisting(password);

    await this.showRecoveryKey(recoveryKey, true);
    return dek;
  }

  // Unlock with the existing keyring (asks for password on a new device, offers recovery).
  private async unlock(data: Keyring): Promise<Buffer | undefined> {
    const stored = await this.secrets.get(PW_SECRET);
    if (stored && data.wraps.password) {
      try {
        this.dek = cy.unwrapKey(data.wraps.password, stored);
        return this.dek;
      } catch {
        // stored password is wrong; we ask again below
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const choice = await vscode.window.showInputBox({
        prompt:
          attempt === 0
            ? 'Enter your master password (leave empty and press Enter to use a recovery key)'
            : 'Wrong password. Try again (leave empty to use a recovery key)',
        password: true,
        ignoreFocusOut: true,
      });

      if (choice === undefined) {
        return undefined; // cancelled
      }

      if (choice === '') {
        return this.unlockWithRecovery(data);
      }

      if (data.wraps.password) {
        try {
          this.dek = cy.unwrapKey(data.wraps.password, choice);
          await this.secrets.store(PW_SECRET, choice);
          return this.dek;
        } catch {
          // loop and ask again
        }
      }
    }
    return undefined;
  }

  private async unlockWithRecovery(data: Keyring): Promise<Buffer | undefined> {
    if (!data.wraps.recovery) {
      vscode.window.showErrorMessage('This keyring has no recovery key set.');
      return undefined;
    }
    const rec = await vscode.window.showInputBox({
      prompt: 'Enter your recovery key',
      ignoreFocusOut: true,
    });
    if (!rec) {
      return undefined;
    }
    try {
      this.dek = cy.unwrapKey(data.wraps.recovery, rec.trim());
    } catch {
      vscode.window.showErrorMessage('Recovery key is invalid.');
      return undefined;
    }
    // After recovery, set a new password and refresh the password slot.
    const newPw = await vscode.window.showInputBox({
      prompt: 'Access granted. Set a new master password for this device',
      password: true,
      ignoreFocusOut: true,
    });
    if (newPw) {
      data.wraps.password = cy.wrapKey(this.dek, newPw);
      await this.saveKeyring(data);
      await this.secrets.store(PW_SECRET, newPw);
    }
    return this.dek;
  }

  // Change the password: the DEK stays the same, only its password wrap is renewed.
  async changePassword(): Promise<void> {
    const dek = await this.getKey();
    if (!dek) {
      return;
    }
    const newPw = await vscode.window.showInputBox({
      prompt: 'New master password',
      password: true,
      ignoreFocusOut: true,
    });
    if (!newPw) {
      return;
    }
    const confirm = await vscode.window.showInputBox({
      prompt: 'Re-enter the new password',
      password: true,
      ignoreFocusOut: true,
    });
    if (confirm !== newPw) {
      vscode.window.showErrorMessage('Passwords did not match.');
      return;
    }
    const found = await this.findKeyring();
    if (!found) {
      return;
    }
    found.data.wraps.password = cy.wrapKey(dek, newPw);
    await this.saveKeyring(found.data);
    await this.secrets.store(PW_SECRET, newPw);
    vscode.window.showInformationMessage('Master password updated.');
  }

  // Generate and show a new recovery key (invalidating the old one).
  async regenerateRecoveryKey(): Promise<void> {
    const dek = await this.getKey();
    if (!dek) {
      return;
    }
    const found = await this.findKeyring();
    if (!found) {
      return;
    }
    const recoveryKey = cy.generateRecoveryKey();
    found.data.wraps.recovery = cy.wrapKey(dek, recoveryKey);
    await this.saveKeyring(found.data);
    await this.showRecoveryKey(recoveryKey, false);
  }

  async forget(): Promise<void> {
    this.dek = undefined;
    await this.secrets.delete(PW_SECRET);
  }

  // Migrate old (plaintext or v1) note content and titles to the v2 (DEK) format.
  private async migrateExisting(password: string): Promise<void> {
    const gists = await this.api.listGists();
    const targets = gists.filter((g) => !this.isKeyringGist(g));
    if (targets.length === 0) {
      return;
    }
    const dek = this.dek!;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Migrating notes to encrypted storage' },
      async (progress) => {
        for (let i = 0; i < targets.length; i++) {
          const g = await this.api.getGist(targets[i].id);

          // Encrypt the title (description) if it is still plaintext.
          const desc = g.description ?? '';
          if (desc && !cy.isV2(desc)) {
            await this.api.updateDescription(g.id, cy.encryptWithKey(desc, dek));
          }

          // Migrate file contents.
          for (const [filename, file] of Object.entries(g.files)) {
            let raw = file.content ?? '';
            if (file.truncated && file.raw_url) {
              raw = await (await fetch(file.raw_url)).text();
            }
            if (cy.isV2(raw)) {
              continue; // already new format
            }
            let plain: string;
            try {
              plain = cy.isV1(raw) ? cy.decryptV1(raw, password) : raw;
            } catch {
              continue; // skip files we cannot decrypt (avoid corrupting them)
            }
            await this.api.updateFile(g.id, filename, cy.encryptWithKey(plain, dek));
          }
          progress.report({ increment: 100 / targets.length, message: `${i + 1}/${targets.length}` });
        }
      },
    );
  }

  // Show the recovery key to the user (with a copy-to-clipboard option).
  private async showRecoveryKey(key: string, firstTime: boolean): Promise<void> {
    const intro = firstTime
      ? 'Setup complete. Save the RECOVERY KEY below somewhere safe.'
      : 'Your new recovery key:';
    const choice = await vscode.window.showWarningMessage(
      `${intro}\n\n${key}\n\nIf you forget your password, this key is the only way to access your notes. It will not be shown again.`,
      { modal: true },
      'Copy to Clipboard',
    );
    if (choice === 'Copy to Clipboard') {
      await vscode.env.clipboard.writeText(key);
      vscode.window.showInformationMessage('Recovery key copied to clipboard.');
    }
  }
}
