# Publishing CoreNote to the VS Code Marketplace

## 0. Prerequisites
- Node.js installed.
- The packaging tool: `npm install -g @vscode/vsce`
- A GitHub account + a repository for this project.
- A Microsoft account (for the Marketplace publisher).

## 1. Set your identity in package.json
Replace the placeholders:
- `"publisher": "your-publisher-id"`  -> your Marketplace publisher id (created in step 3).
- `repository`, `bugs`, `homepage` URLs -> your GitHub repo.

## 2. Push the project to GitHub (so the README image resolves)
The README references `docs/demo.gif`. For it to appear on the Marketplace page, that file must
exist in your pushed repo.
```bash
git init && git add . && git commit -m "CoreNote 1.0.0"
git branch -M main
git remote add origin https://github.com/<you>/corenote.git
git push -u origin main
```

## 3. Create a Marketplace publisher
1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Microsoft account.
3. Click **Create publisher**, set an **ID** (permanent, used in the extension URL) and a **Name**.
4. Put that ID into `package.json` -> `"publisher"`.

## 4. Package
```bash
vsce package
```
This produces `corenote-1.0.0.vsix`.

## 5. Publish — choose ONE path

### Path A — Manual upload (simplest, no token)
1. On https://marketplace.visualstudio.com/manage, open your publisher.
2. Click **New extension -> Visual Studio Code**.
3. Upload `corenote-1.0.0.vsix`. Done — it goes live after a short validation.

### Path B — Command line
1. Create an Azure DevOps Personal Access Token with the **Marketplace -> Manage** scope.
   (Note: global PATs in Azure DevOps are retired on Dec 1, 2026; after that use Microsoft
   Entra ID-based publishing.)
2. Authenticate and publish:
   ```bash
   vsce login <your-publisher-id>
   vsce publish
   ```
   `vsce publish patch|minor|major` also bumps the version automatically.

## 6. Updating later
Bump `"version"` in package.json, then `vsce publish` (or upload a new `.vsix` via the portal).

## 7. Optional — Open VSX (for VSCodium, Cursor, Windsurf, etc.)
```bash
npm install -g ovsx
ovsx create-namespace <your-publisher-id> -p <open-vsx-token>
ovsx publish corenote-1.0.0.vsix -p <open-vsx-token>
```

## Notes
- An extension name is a permanent unique id once published; if removed, the name is reserved
  forever and cannot be reused.
- Before publishing, confirm "CoreNote" is free by searching the Marketplace.
