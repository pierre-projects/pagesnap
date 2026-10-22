#!/usr/bin/env node
// Windows only: adds a "pagesnap" shortcut to the Start menu that runs bin/pagesnap-ui.vbs, so
// the UI can be started from the Start menu or a taskbar pin without a console window.

import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('pagesnap: the shortcut is for Windows. Elsewhere, run `pagesnap --ui`.');
  process.exit(1);
}

const bin = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(bin);
const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const lnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'pagesnap.lnk');
const wscript = path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'wscript.exe');

// Single quotes are doubled for PowerShell's single-quoted strings.
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const ps = [
  `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)})`,
  `$s.TargetPath = ${q(wscript)}`,
  `$s.Arguments = ${q(`"${path.join(bin, 'pagesnap-ui.vbs')}"`)}`,
  `$s.WorkingDirectory = ${q(root)}`,
  `$s.IconLocation = ${q(`${path.join(bin, 'pagesnap.ico')},0`)}`,
  `$s.Description = 'Full-page web screenshots'`,
  '$s.Save()',
].join('; ');

try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
  console.error('pagesnap: could not make the shortcut.');
  process.exit(1);
}
console.log(`Made ${lnk}`);
console.log('Find "pagesnap" in the Start menu, right-click it and choose "Pin to taskbar".');
