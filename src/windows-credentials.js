import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';

const credentialTarget = 'orgen/openrouter';

export function createCredentialStore({ target = credentialTarget } = {}) {
  async function invoke(operation, key) {
    if (process.platform !== 'win32' &&
        !(process.platform === 'linux' && /microsoft/i.test(release()))) {
      throw new Error('Keychain storage requires Windows or WSL. Set OPENROUTER_API_KEY to run generation here.');
    }

    const source = await readFile(new URL('./windows-credentials.ps1', import.meta.url), 'utf8');
    const command = Buffer.from(source, 'utf16le').toString('base64');
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;

    return new Promise((resolve, reject) => {
      const child = execFile('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command,
      ], { env, windowsHide: true, timeout: 20_000 }, (error, stdout) => {
        // Only the read operation emits a key, and its output stays in this process.
        if (!error) return resolve(stdout);
        if (error.code === 3 && operation === 'get') return resolve(undefined);
        reject(new Error(
          'Could not access Windows Credential Manager. Use a Windows or WSL terminal with interoperability enabled, or set OPENROUTER_API_KEY for generation.',
        ));
      });

      child.stdin.on('error', () => {
        // The execFile callback handles a helper that exits before consuming input.
      });
      child.stdin.end(`${operation}\n${target}\n${key ?? ''}\n`);
    });
  }

  return {
    get: () => invoke('get'),
    set: (key) => invoke('set', key),
    clear: () => invoke('clear'),
  };
}
