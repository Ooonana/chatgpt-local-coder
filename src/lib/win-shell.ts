import fs from "node:fs";

export function getWinShell(): { shell: string; isPwsh: boolean } {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell && /(?:^|[\\/])(pwsh|powershell)(?:\.exe)?$/i.test(configuredShell)) {
    return { shell: configuredShell, isPwsh: /pwsh(?:\.exe)?$/i.test(configuredShell) };
  }

  const pwshPaths = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
  ];
  for (const candidate of pwshPaths) {
    if (fs.existsSync(candidate)) return { shell: candidate, isPwsh: true };
  }

  const sysPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (fs.existsSync(sysPowerShell)) return { shell: sysPowerShell, isPwsh: false };
  return { shell: "powershell.exe", isPwsh: false };
}