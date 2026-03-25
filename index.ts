import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
const IS_WIN = process.platform === 'win32';

type OpenclawConfig = Record<string, unknown>;
type ParsedJsonObject = Record<string, unknown>;

interface MoltbankPluginConfig {
  skillName?: string;
  appBaseUrl?: string;
}

interface CredentialsOrganization {
  name?: string;
  access_token?: string;
  x402_signer_private_key?: string;
}

interface CredentialsFile {
  active_organization?: string;
  organizations?: CredentialsOrganization[];
}

interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
}

interface LoggerApi {
  logger: LoggerLike;
}

interface ServiceDefinition {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}

interface CliCommandLike {
  command(name: string): CliCommandLike;
  createCommand(name: string): CliCommandLike;
  description(text: string): CliCommandLike;
  addCommand(command: CliCommandLike): CliCommandLike;
  action(handler: () => void | Promise<void>): CliCommandLike;
}

interface PluginApiConfig {
  plugins?: {
    entries?: {
      moltbank?: {
        config?: MoltbankPluginConfig;
      };
    };
  };
}

interface PluginApi extends LoggerApi {
  config?: PluginApiConfig;
  registerService(service: ServiceDefinition): void;
  registerCli(handler: (args: { program: CliCommandLike }) => void, options: { commands: string[] }): void;
}

type AuthWaitMode = 'blocking' | 'nonblocking';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

function getSetupAuthWaitMode(defaultMode: AuthWaitMode): AuthWaitMode {
  const raw = asString(process.env.MOLTBANK_SETUP_AUTH_WAIT_MODE).trim().toLowerCase();
  if (raw === 'blocking' || raw === 'wait') return 'blocking';
  if (raw === 'nonblocking' || raw === 'nowait') return 'nonblocking';
  return defaultMode;
}

function getExecErrorMessage(error: unknown): string {
  if (isRecord(error) && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string') {
      return stderr.trim();
    }
    if (isRecord(stderr) && 'toString' in stderr && typeof (stderr as { toString?: unknown }).toString === 'function') {
      return (stderr as { toString: () => string }).toString().trim();
    }
  }
  return String(error);
}

function run(cmd: string, opts: { cwd?: string; silent?: boolean } = {}) {
  try {
    const out = execSync(cmd, {
      cwd: opts.cwd,
      stdio: opts.silent ? 'pipe' : 'inherit',
      env: { ...process.env },
      shell: IS_WIN ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash'
    });
    return { ok: true, stdout: out?.toString().trim() ?? '' };
  } catch (e: unknown) {
    return {
      ok: false,
      stdout: '',
      stderr: getExecErrorMessage(e)
    };
  }
}

function hasBin(bin: string) {
  return run(IS_WIN ? `where ${bin}` : `which ${bin}`, { silent: true }).ok;
}

function getWorkspace(): string {
  return process.env.OPENCLAW_WORKSPACE || join(homedir(), '.openclaw', 'workspace');
}

function getSkillName(cfg: MoltbankPluginConfig): string {
  return cfg?.skillName || process.env.MOLTBANK_SKILL_NAME || 'MoltBank';
}

function getAppBaseUrl(cfg: MoltbankPluginConfig): string {
  return (cfg?.appBaseUrl || process.env.APP_BASE_URL || 'https://app.moltbank.bot').trim();
}

function isSandboxEnabled(): boolean {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const mode = config?.agents?.defaults?.sandbox?.mode?.toLowerCase();
    return mode === 'all' || mode === 'non-main';
  } catch {
    return false;
  }
}

function getSkillDir(cfg: MoltbankPluginConfig): string {
  const skillName = getSkillName(cfg);
  return join(getWorkspace(), 'skills', skillName);
}

function getCredentialsPath(): string {
  return process.env.MOLTBANK_CREDENTIALS_PATH || join(homedir(), '.MoltBank', 'credentials.json');
}

function readOpenclawConfig(): OpenclawConfig {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeOpenclawConfig(config: OpenclawConfig): void {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return;

  let current: Record<string, unknown> = obj;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isRecord(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[path[path.length - 1]] = value;
}

function cleanupStaleMoltbankPluginLoadPaths(api: LoggerApi): boolean {
  try {
    const config = readOpenclawConfig();
    const loadPathsPath = ['plugins', 'load', 'paths'];
    const current = getNestedValue(config, loadPathsPath);
    if (!Array.isArray(current)) return false;

    const removed: string[] = [];
    const next: unknown[] = [];

    for (const entry of current) {
      if (typeof entry !== 'string') {
        next.push(entry);
        continue;
      }

      const normalized = entry.replace(/\\/g, '/').toLowerCase();
      const looksLikeMoltbankPath = normalized.includes('moltbank');
      if (looksLikeMoltbankPath && !existsSync(entry)) {
        removed.push(entry);
        continue;
      }

      next.push(entry);
    }

    if (removed.length === 0) {
      api.logger.info('[moltbank] ✓ no stale MoltBank plugin load paths found');
      return false;
    }

    setNestedValue(config, loadPathsPath, next);
    writeOpenclawConfig(config);
    api.logger.info(`[moltbank] ✓ removed stale MoltBank plugin load path(s): ${removed.join(', ')}`);
    return true;
  } catch (e) {
    api.logger.warn('[moltbank] could not clean stale MoltBank plugin load paths: ' + String(e));
    return false;
  }
}

// ─── mcporter ────────────────────────────────────────────────────────────────

function ensureMcporter(api: LoggerApi) {
  if (hasBin('mcporter')) {
    const v = run('mcporter --version', { silent: true });
    api.logger.info(`[moltbank] ✓ mcporter already installed (${v.stdout || 'unknown version'})`);
    return;
  }
  api.logger.info('[moltbank] installing mcporter globally...');
  const result = run('npm install -g mcporter');
  if (result.ok) {
    api.logger.info('[moltbank] ✓ mcporter installed');
  } else {
    api.logger.warn('[moltbank] ✗ mcporter install failed: ' + result.stderr);
  }
}

function ensureWrapperExecutable(skillDir: string, api: LoggerApi): void {
  if (IS_WIN) return;
  const wrapperPath = join(skillDir, 'scripts', 'moltbank.sh');
  if (!existsSync(wrapperPath)) return;

  try {
    chmodSync(wrapperPath, 0o755);
    api.logger.info('[moltbank] ✓ wrapper script permissions ensured (scripts/moltbank.sh)');
  } catch (e) {
    api.logger.warn('[moltbank] could not ensure wrapper executable bit: ' + String(e));
  }
}

// ─── skill install ───────────────────────────────────────────────────────────

const SKILL_FILES = [
  'skill.md',
  'setup.md',
  'onboarding.md',
  'multi-org.md',
  'tools-reference.md',
  'x402-workflow.md',
  'heartbeat.md',
  'rules.md',
  'skill.json',
  'polymarket-workflow.md',
  'polymarket-operation.md',
  'polymarket-refill.md',
  'openclaw-signer-eoa.md',
  'openclaw-solana-signer.md',
  'pumpfun-workflow.md',
  'config/mcporter.json',
  'scripts/openclaw-runtime-config.mjs',
  'scripts/request-oauth-device-code.mjs',
  'scripts/init-openclaw-signer.mjs',
  'scripts/init-openclaw-solana-signer.mjs',
  'scripts/bootstrap-openclaw-pumpfun-wallet.mjs',
  'scripts/inspect-x402-requirements.mjs',
  'scripts/inspect-solana-wallet.mjs',
  'scripts/inspect-polygon-wallet.mjs',
  'scripts/quote-solana-budget.mjs',
  'scripts/polymarket-execute-lifi-tx.mjs',
  'scripts/polymarket-signer-to-safe.mjs',
  'scripts/poll-oauth-token.mjs',
  'scripts/export-api-key.mjs',
  'scripts/fetch-openrouter-intent.mjs',
  'scripts/x402-pay-and-confirm.mjs',
  'scripts/pumpportal-trade-local.mjs',
  'scripts/moltbank.sh',
  'scripts/moltbank.ps1',
  'scripts/polymarket-service.mjs'
];

function ensureSkillInstalled(
  skillDir: string,
  appBaseUrl: string,
  skillName: string,
  api: LoggerApi,
  mode: 'sandbox' | 'host' = 'sandbox'
) {
  const successFlag = join(skillDir, '.install_success');
  if (existsSync(successFlag)) {
    ensureWrapperExecutable(skillDir, api);
    api.logger.info('[moltbank] ✓ skill already installed at ' + skillDir);
    return true;
  }

  api.logger.info(`[moltbank] installing skill '${skillName}' to ${skillDir} (mode: ${mode})`);
  mkdirSync(skillDir, { recursive: true });

  const filesJson = JSON.stringify(SKILL_FILES).replace(/"/g, '\\"');
  const installNode = run(
    `node --input-type=module -e "import fs from 'fs'; import path from 'path'; const baseRaw=process.argv[1]; const dir=process.argv[2]; const files=JSON.parse(process.argv[3]); const base=baseRaw.endsWith('/') ? baseRaw.slice(0,-1) : baseRaw; fs.mkdirSync(dir,{recursive:true}); for (const f of files){ const u=base+'/'+f; const out=path.join(dir,f); fs.mkdirSync(path.dirname(out),{recursive:true}); const r=await fetch(u); if(!r.ok){ console.error('download failed',u,r.status); process.exit(2);} fs.writeFileSync(out, await r.text(),'utf8'); } fs.writeFileSync(path.join(dir,'.install_success'),'ok\\n','utf8');" "${appBaseUrl}" "${skillDir}" "${filesJson}"`,
    { cwd: dirname(skillDir), silent: true }
  );

  if (installNode.ok) {
    ensureWrapperExecutable(skillDir, api);
    api.logger.info('[moltbank] ✓ skill installed at ' + skillDir);
    return true;
  }

  api.logger.warn('[moltbank] ✗ skill install failed: ' + installNode.stderr);
  return false;
}
// ─── SKILL.md uppercase + frontmatter ────────────────────────────────────────

function ensureSkillFilesUppercase(skillDir: string, api: LoggerApi) {
  const lower = join(skillDir, 'skill.md');
  const upper = join(skillDir, 'SKILL.md');
  if (existsSync(upper)) {
    api.logger.info('[moltbank] ✓ SKILL.md already exists');
    return;
  }
  if (existsSync(lower)) {
    renameSync(lower, upper);
    api.logger.info('[moltbank] ✓ renamed skill.md → SKILL.md');
  } else {
    api.logger.warn('[moltbank] ✗ neither skill.md nor SKILL.md found');
  }
}

function fixSkillFrontmatter(skillDir: string, skillName: string, api: LoggerApi) {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    api.logger.warn('[moltbank] ✗ SKILL.md not found — skipping frontmatter fix');
    return;
  }

  const content = readFileSync(skillFile, 'utf8').replace(/\r\n/g, '\n');
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    api.logger.warn('[moltbank] ✗ no frontmatter in SKILL.md');
    return;
  }

  const binsYaml = IS_WIN ? '        - mcporter' : '        - mcporter\n        - jq';
  const newFrontmatter = `---
name: ${skillName}
version: 1.5.3
description: MCP skill for MoltBank business banking workflows (treasury, approvals, allowances, x402, OpenRouter, Polymarket, and Pump.Fun).
homepage: \${APP_BASE_URL:-https://app.moltbank.bot}
metadata:
  category: finance
  api_base: \${APP_BASE_URL:-https://app.moltbank.bot}/api/mcp
  install_script: \${APP_BASE_URL:-https://app.moltbank.bot}/install.sh
  openclaw:
    requires:
      bins:
${binsYaml}
      npm:
        - '@x402/fetch@^2.3.0'
        - '@x402/evm@^2.3.1'
        - 'viem@^2.46.0'
        - '@polymarket/clob-client'
        - 'ethers@5'
        - '@solana/web3.js@^1.98.4'
        - 'bs58@^6.0.0'
    primaryEnv: MOLTBANK
---`;

  const body = content.slice(frontmatterMatch[0].length);
  const fixed = newFrontmatter + body;

  if (fixed !== content) {
    writeFileSync(skillFile, fixed, 'utf8');
    api.logger.info(`[moltbank] ✓ SKILL.md frontmatter fixed → name: ${skillName}`);
  } else {
    api.logger.info('[moltbank] ✓ SKILL.md frontmatter already correct');
  }
}

function ensureSkillPermissions(skillDir: string, api: LoggerApi) {
  if (IS_WIN) {
    api.logger.info('[moltbank] ✓ skipping unix permissions (Windows)');
    return;
  }

  const configDir = join(skillDir, 'config');
  const configFile = join(skillDir, 'config', 'mcporter.json');
  const scriptsDir = join(skillDir, 'scripts');

  const user = run('whoami', { silent: true }).stdout;
  if (user && existsSync(skillDir)) {
    run(`chown -R ${user} "${skillDir}"`, { silent: true });
    api.logger.info(`[moltbank] ✓ ownership corrected to ${user}`);
  }

  if (existsSync(configDir)) {
    run(`chmod 777 "${configDir}"`, { silent: true });
    api.logger.info('[moltbank] ✓ config/ permissions → 777');
  }
  if (existsSync(configFile)) {
    run(`chmod 666 "${configFile}"`, { silent: true });
    api.logger.info('[moltbank] ✓ mcporter.json permissions → 666');
  }
  if (existsSync(scriptsDir)) {
    run(`chmod -R 755 "${scriptsDir}"`, { silent: true });
    api.logger.info('[moltbank] ✓ scripts/ permissions → 755');
    run(`find "${scriptsDir}" -type f | xargs sed -i 's/\r$//'`, {
      silent: true
    });
    api.logger.info('[moltbank] ✓ scripts/ line endings normalized (CRLF → LF)');
  }

  if (existsSync(skillDir)) {
    run(`find "${skillDir}" -maxdepth 1 -name "*.md" | xargs sed -i 's/\r$//'`, { silent: true });
    api.logger.info('[moltbank] ✓ .md files line endings normalized (CRLF → LF)');
  }
}

// ─── npm deps ─────────────────────────────────────────────────────────────────

function ensureNpmDeps(skillDir: string, api: LoggerApi, mode: 'sandbox' | 'host' = 'sandbox') {
  const pkgPath = join(skillDir, 'package.json');
  if (!existsSync(pkgPath)) {
    const fallbackPkg = {
      name: 'moltbank-skill-runtime',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        '@x402/fetch': '^2.3.0',
        '@x402/evm': '^2.3.1',
        viem: '^2.46.0',
        '@polymarket/clob-client': 'latest',
        ethers: '^5.8.0',
        '@solana/web3.js': '^1.98.4',
        bs58: '^6.0.0'
      }
    };
    writeFileSync(pkgPath, JSON.stringify(fallbackPkg, null, 2) + '\n', 'utf8');
    api.logger.warn('[moltbank] package.json not found — created fallback package.json for skill runtime deps');
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dependencies = pkg.dependencies ?? {};
    const cur = String(pkg.dependencies['@polymarket/clob-client'] ?? '').trim();
    if (!cur || cur === '^6.0.0') {
      pkg.dependencies['@polymarket/clob-client'] = 'latest';
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      api.logger.info('[moltbank] normalized package.json: @polymarket/clob-client -> latest');
    }
  } catch (e) {
    api.logger.warn('[moltbank] could not normalize package.json deps: ' + String(e));
  }
  api.logger.info('[moltbank] installing npm deps...');
  if (mode === 'sandbox') {
    const result = run('npm install --ignore-scripts', { cwd: skillDir });
    if (result.ok) {
      api.logger.info('[moltbank] ✓ npm deps installed');
    } else {
      api.logger.warn('[moltbank] ✗ npm install failed: ' + result.stderr);
    }
    return;
  }

  const hasLock = existsSync(join(skillDir, 'package-lock.json')) || existsSync(join(skillDir, 'npm-shrinkwrap.json'));
  if (hasLock) {
    const ci = run('npm ci', { cwd: skillDir });
    if (ci.ok) {
      api.logger.info('[moltbank] ✓ npm deps installed with npm ci');
      return;
    }
    api.logger.warn('[moltbank] npm ci failed; trying npm install: ' + ci.stderr);
  }
  const install = run('npm install', { cwd: skillDir });
  if (install.ok) {
    api.logger.info('[moltbank] ✓ npm deps installed with npm install');
    return;
  }
  api.logger.warn('[moltbank] npm install failed; trying safe fallback --ignore-scripts');
  const fallback = run('npm install --ignore-scripts', { cwd: skillDir });
  if (fallback.ok) {
    api.logger.warn('[moltbank] npm deps installed with fallback --ignore-scripts (some packages may require postinstall)');
  } else {
    api.logger.warn('[moltbank] ✗ npm dependency install failed: ' + fallback.stderr);
  }
}

function isMoltBankRegistered(): boolean {
  const result = run('mcporter config list', { silent: true });
  return result.stdout.toLowerCase().includes('moltbank');
}

function parseActiveTokenFromCredentials(): {
  ok: boolean;
  activeOrg?: string;
  token?: string;
  privateKey?: string;
} {
  const credsPath = getCredentialsPath();
  if (!existsSync(credsPath)) return { ok: false };
  try {
    const creds = JSON.parse(readFileSync(credsPath, 'utf8')) as CredentialsFile;
    const activeOrg = creds?.active_organization;
    if (!activeOrg) return { ok: false };
    const org = creds.organizations?.find((o: CredentialsOrganization) => o.name === activeOrg);
    if (!org?.access_token) return { ok: false };
    return {
      ok: true,
      activeOrg,
      token: org.access_token,
      privateKey: org.x402_signer_private_key ?? undefined
    };
  } catch {
    return { ok: false };
  }
}

function parseFirstJsonObject(output: string): ParsedJsonObject | null {
  const trimmed = (output || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const maybe = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(maybe);
    } catch {}
  }
  return null;
}

function ensureMoltbankAuth(
  skillDir: string,
  appBaseUrl: string,
  api: LoggerApi,
  options: { waitForApproval?: boolean } = {}
): boolean {
  const waitForApproval = options.waitForApproval ?? true;
  const existing = parseActiveTokenFromCredentials();
  if (existing.ok) {
    api.logger.info(`[moltbank] ✓ credentials.json already available (active org: ${existing.activeOrg})`);
    return true;
  }

  const credsPath = getCredentialsPath();
  const pendingPath = join(skillDir, '.oauth_device_code.json');
  const now = Math.floor(Date.now() / 1000);

  let deviceCode = '';
  let userCode = '';
  let verificationUri = `${appBaseUrl}/activate`;
  let expiresAt = 0;

  if (existsSync(pendingPath)) {
    try {
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as Record<string, unknown>;
      const pendingDeviceCode = asString(pending.device_code);
      const pendingUserCode = asString(pending.user_code);
      const pendingVerificationUri = asString(pending.verification_uri, verificationUri);
      const pendingExpiresAtRaw = pending.expires_at;
      const pendingExpiresAt = typeof pendingExpiresAtRaw === 'number' ? pendingExpiresAtRaw : 0;

      if (pendingDeviceCode && pendingUserCode && pendingExpiresAt > now + 5) {
        deviceCode = pendingDeviceCode;
        userCode = pendingUserCode;
        verificationUri = pendingVerificationUri;
        expiresAt = pendingExpiresAt;
        api.logger.info(`[moltbank] reusing pending OAuth device code (expires in ~${Math.max(1, Math.ceil((expiresAt - now) / 60))} min)`);
      } else {
        unlinkSync(pendingPath);
      }
    } catch {
      try {
        unlinkSync(pendingPath);
      } catch {
        // ignore
      }
    }
  }

  if (!deviceCode || !userCode) {
    api.logger.info('[moltbank] no valid credentials found — starting onboarding flow...');

    const requestCode = run(
      `APP_BASE_URL="${appBaseUrl}" MOLTBANK_CREDENTIALS_PATH="${credsPath}" node "./scripts/request-oauth-device-code.mjs"`,
      { cwd: skillDir, silent: true }
    );

    if (!requestCode.ok) {
      api.logger.warn('[moltbank] ✗ could not request OAuth device code: ' + requestCode.stderr);
      return false;
    }

    const codeJson = parseFirstJsonObject(requestCode.stdout);
    deviceCode = asString(codeJson?.device_code);
    userCode = asString(codeJson?.user_code);
    verificationUri = asString(codeJson?.verification_uri, `${appBaseUrl}/activate`);

    const expiresInRaw = codeJson?.expires_in;
    const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : Number(expiresInRaw ?? 900);
    const safeExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 900;
    expiresAt = now + safeExpiresIn;

    if (!deviceCode || !userCode) {
      api.logger.warn('[moltbank] ✗ onboarding response missing device_code/user_code');
      return false;
    }

    try {
      writeFileSync(
        pendingPath,
        JSON.stringify(
          {
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: verificationUri,
            expires_at: expiresAt
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
    } catch (e) {
      api.logger.warn('[moltbank] could not persist pending OAuth device code: ' + String(e));
    }
  } else {
    api.logger.info('[moltbank] no valid credentials found — pending onboarding code already issued');
  }

  api.logger.info('[moltbank] ACTION REQUIRED: link this agent to your MoltBank account');
  api.logger.info(`[moltbank] 1) Open: ${verificationUri}`);
  api.logger.info(`[moltbank] 2) Enter code: ${userCode}`);
  if (expiresAt > now) {
    api.logger.info(`[moltbank] 3) Code expires in ~${Math.max(1, Math.ceil((expiresAt - now) / 60))} min`);
  }

  if (!waitForApproval) {
    api.logger.info('[moltbank] nonblocking startup mode: skipping OAuth polling to keep gateway/channel startup responsive');
    api.logger.info('[moltbank] once approved, rerun `openclaw moltbank setup` or send another MoltBank command');
    return false;
  }

  api.logger.info('[moltbank] waiting for approval and polling token...');

  const pollTimeoutSeconds = Number(process.env.MOLTBANK_OAUTH_POLL_TIMEOUT_SECONDS ?? 180);
  const safePollTimeoutSeconds = Number.isFinite(pollTimeoutSeconds) && pollTimeoutSeconds > 0 ? Math.floor(pollTimeoutSeconds) : 180;
  const pollIntervalSeconds = Number(process.env.MOLTBANK_OAUTH_POLL_INTERVAL_SECONDS ?? 5);
  const safePollIntervalSeconds = Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds > 0 ? Math.floor(pollIntervalSeconds) : 5;

  const poll = run(
    `APP_BASE_URL=\"${appBaseUrl}\" MOLTBANK_CREDENTIALS_PATH=\"${credsPath}\" node \"./scripts/poll-oauth-token.mjs\" \"${deviceCode}\" ${safePollTimeoutSeconds} ${safePollIntervalSeconds} --save`,
    { cwd: skillDir, silent: true }
  );
  if (!poll.ok) {
    const pollJson = parseFirstJsonObject(`${poll.stdout}\n${poll.stderr}`);
    let oauthError = '';
    if (isRecord(pollJson) && isRecord(pollJson.payload)) {
      oauthError = asString((pollJson.payload as Record<string, unknown>).error);
    }

    if (oauthError === 'invalid_grant') {
      api.logger.warn('[moltbank] ✗ onboarding code expired or already consumed (invalid_grant)');
      try {
        if (existsSync(pendingPath)) unlinkSync(pendingPath);
      } catch {
        // ignore
      }
    } else {
      api.logger.warn('[moltbank] ✗ onboarding poll failed or timed out');
    }

    if (poll.stderr) {
      api.logger.warn('[moltbank] poll detail: ' + poll.stderr);
    }
    return false;
  }

  const after = parseActiveTokenFromCredentials();
  if (!after.ok) {
    api.logger.warn('[moltbank] ✗ onboarding finished but credentials are not usable');
    return false;
  }

  try {
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
  } catch {
    // ignore
  }

  api.logger.info(`[moltbank] ✓ onboarding completed (active org: ${after.activeOrg})`);
  return true;
}

function ensureMcporterConfig(skillDir: string, appBaseUrl: string, api: LoggerApi) {
  const cfgPath = join(skillDir, 'config', 'mcporter.json');
  mkdirSync(join(skillDir, 'config'), { recursive: true });

  const cfg = {
    mcpServers: {
      MoltBank: {
        description: 'MoltBank stablecoin banking MCP server powered by Fondu',
        transport: 'sse',
        url: `${appBaseUrl}/api/mcp`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ${MOLTBANK}'
        }
      }
    }
  };

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  api.logger.info('[moltbank] ✓ mcporter.json written: ' + cfgPath);

  if (!hasBin('mcporter')) {
    api.logger.warn('[moltbank] ✗ mcporter not in PATH — cannot register');
    return;
  }

  if (isMoltBankRegistered()) {
    api.logger.info('[moltbank] ✓ MoltBank already registered in mcporter');
    return;
  }

  api.logger.info('[moltbank] registering MoltBank in mcporter (scope: home)...');

  const addCmd =
    `mcporter config add MoltBank ` +
    `--url "${appBaseUrl}/api/mcp" ` +
    `--transport sse ` +
    `--header "Authorization=Bearer \${MOLTBANK}" ` +
    `--header "Content-Type=application/json" ` +
    `--description "MoltBank stablecoin banking MCP server powered by Fondu" ` +
    `--scope home`;

  const result = run(addCmd, { silent: false });

  if (result.ok) {
    api.logger.info('[moltbank] ✓ MoltBank registered in mcporter');
    const list = run('mcporter config list', { silent: true });
    api.logger.info('[moltbank] mcporter config list: ' + list.stdout);
  } else {
    api.logger.warn('[moltbank] ✗ mcporter config add failed: ' + result.stderr);
  }
}

// ─── sandbox env vars ────────────────────────────────────────────────────────

function injectSandboxEnv(skillDir: string, api: LoggerApi): boolean {
  const credsPath = getCredentialsPath();

  if (!existsSync(credsPath)) {
    api.logger.info('[moltbank] no credentials.json found — skipping sandbox env injection');
    return false;
  }

  let changed = false;

  try {
    const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    const activeOrg = creds.active_organization;

    if (!activeOrg) {
      api.logger.warn('[moltbank] ✗ active_organization not set in credentials.json');
      return false;
    }

    const org = creds.organizations?.find((o: CredentialsOrganization) => o.name === activeOrg);
    if (!org?.access_token) {
      api.logger.warn(`[moltbank] ✗ no access_token for active org "${activeOrg}"`);
      return false;
    }

    const config = readOpenclawConfig();
    const envPath = ['agents', 'defaults', 'sandbox', 'docker', 'env'];
    setNestedValue(config, envPath, getNestedValue(config, envPath) ?? {});
    const envObj = getNestedValue(config, envPath) as Record<string, string>;

    if (envObj.MOLTBANK !== org.access_token) {
      envObj.MOLTBANK = org.access_token;
      api.logger.info(`[moltbank] ✓ MOLTBANK injected (org: ${activeOrg})`);
      changed = true;
    } else {
      api.logger.info(`[moltbank] ✓ MOLTBANK already injected (org: ${activeOrg})`);
    }

    if (envObj.ACTIVE_ORG_OVERRIDE !== activeOrg) {
      envObj.ACTIVE_ORG_OVERRIDE = activeOrg;
      api.logger.info(`[moltbank] ✓ ACTIVE_ORG_OVERRIDE injected ("${activeOrg}")`);
      changed = true;
    } else {
      api.logger.info(`[moltbank] ✓ ACTIVE_ORG_OVERRIDE already set ("${activeOrg}")`);
    }

    let privateKey = org.x402_signer_private_key ?? '';

    if (!privateKey) {
      api.logger.info('[moltbank] x402_signer_private_key not found — generating EOA signer...');
      const initResult = run(`MOLTBANK_CREDENTIALS_PATH="${credsPath}" node "./scripts/init-openclaw-signer.mjs"`, {
        cwd: skillDir,
        silent: true
      });
      if (!initResult.ok) {
        api.logger.warn('[moltbank] ✗ could not generate EOA signer: ' + initResult.stderr);
        api.logger.warn('[moltbank]   agent will generate signer on first x402/Polymarket use');
      } else {
        const freshCreds = JSON.parse(readFileSync(credsPath, 'utf8')) as CredentialsFile;
        const freshOrg = freshCreds.organizations?.find((o: CredentialsOrganization) => o.name === activeOrg);
        privateKey = freshOrg?.x402_signer_private_key ?? '';
        if (privateKey) {
          api.logger.info('[moltbank] ✓ EOA signer generated and saved');
        } else {
          api.logger.warn('[moltbank] ✗ init-openclaw-signer.mjs ran but key not found');
        }
      }
    }

    if (privateKey) {
      if (envObj.SIGNER !== privateKey) {
        envObj.SIGNER = privateKey;
        api.logger.info('[moltbank] ✓ SIGNER injected');
        changed = true;
      } else {
        api.logger.info('[moltbank] ✓ SIGNER already injected');
      }
    } else {
      api.logger.info('[moltbank] ℹ SIGNER not available — skipped (agent will handle on first use)');
    }

    if (changed) {
      writeOpenclawConfig(config);
      api.logger.info('[moltbank] ✓ openclaw.json updated with sandbox env vars');
    }

    return changed;
  } catch (e) {
    api.logger.warn('[moltbank] ✗ error injecting sandbox env: ' + String(e));
    return false;
  }
}

// ─── sandbox docker config ────────────────────────────────────────────────────

function configureSandbox(api: LoggerApi): boolean {
  const SETUP_CMD =
    'echo \'APT::Sandbox::User "root";\' > /etc/apt/apt.conf.d/99sandbox && ' +
    'apt-get update -qq && ' +
    "echo '[moltbank:sandbox] [1/7] installing base apt deps...' && " +
    'apt-get install -y curl wget jq ca-certificates gnupg && ' +
    "echo '[moltbank:sandbox] [2/7] configuring NodeSource (Node 22)...' && " +
    'mkdir -p /etc/apt/keyrings && ' +
    'curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | ' +
    'gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && ' +
    "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list && " +
    "echo '[moltbank:sandbox] [3/7] apt update...' && " +
    'apt-get update -qq && ' +
    "echo '[moltbank:sandbox] [4/7] installing Node.js 22 + npm...' && " +
    'apt-get install -y nodejs npm && ' +
    "echo '[moltbank:sandbox] forcing Node 22 as default...' && " +
    'NODE22_BIN=$(which node) && ' +
    'update-alternatives --install /usr/local/bin/node node $NODE22_BIN 100 2>/dev/null || true && ' +
    'update-alternatives --set node $NODE22_BIN 2>/dev/null || true && ' +
    'node -v && npm -v && ' +
    "echo '[moltbank:sandbox] [5/7] installing npm global deps (mcporter + sdk libs)...' && " +
    'npm install -g mcporter @x402/fetch@2.3.0 @x402/evm@2.3.1 viem@2.46.0 @polymarket/clob-client ethers@5 @solana/web3.js@1.98.4 bs58@6.0.0 && ' +
    "echo '[moltbank:sandbox] [6/7] verifying mcporter binary...' && " +
    "NPM_GLOBAL=$(npm root -g 2>/dev/null | sed 's|/node_modules$|/bin|' || true) && " +
    'if [ -n "$NPM_GLOBAL" ] && [ -x "$NPM_GLOBAL/mcporter" ]; then ln -sf "$NPM_GLOBAL/mcporter" /usr/local/bin/mcporter || true; fi && ' +
    'command -v mcporter >/dev/null 2>&1 && ' +
    'mcporter --version && ' +
    "echo '[moltbank:sandbox] final versions:' && " +
    'node --version && ' +
    'mcporter --version && ' +
    "echo '[moltbank:sandbox] [7/7] sandbox setup finished successfully'";

  try {
    let changed = false;
    const config = readOpenclawConfig();

    const currentCmd = asString(getNestedValue(config, ['agents', 'defaults', 'sandbox', 'docker', 'setupCommand']));
    const hasMcporterSetup = currentCmd.includes('mcporter');
    const hasNode22Setup = currentCmd.includes('node_22.x');
    const hasNode22Fix = currentCmd.includes('update-alternatives');
    const isCorrupted = currentCmd.includes('/home/') || currentCmd.includes('Unknown command');

    if (!hasMcporterSetup || !hasNode22Setup || !hasNode22Fix || isCorrupted) {
      setNestedValue(config, ['agents', 'defaults', 'sandbox', 'docker', 'setupCommand'], SETUP_CMD);
      api.logger.info('[moltbank] ✓ sandbox setupCommand written directly to JSON (no shell expansion)');
      changed = true;
    } else {
      api.logger.info('[moltbank] ✓ sandbox setupCommand already correct');
    }

    const currentNetwork = getNestedValue(config, ['agents', 'defaults', 'sandbox', 'docker', 'network']);
    if (currentNetwork !== 'bridge') {
      setNestedValue(config, ['agents', 'defaults', 'sandbox', 'docker', 'network'], 'bridge');
      api.logger.info('[moltbank] ✓ sandbox network set to bridge');
      changed = true;
    }

    setNestedValue(config, ['agents', 'defaults', 'sandbox', 'docker', 'readOnlyRoot'], false);
    setNestedValue(config, ['agents', 'defaults', 'sandbox', 'docker', 'user'], '0:0');
    setNestedValue(config, ['agents', 'defaults', 'sandbox', 'workspaceAccess'], 'rw');

    writeOpenclawConfig(config);
    api.logger.info('[moltbank] ✓ sandbox docker configured (written directly to openclaw.json)');
    return changed;
  } catch (e) {
    api.logger.warn('[moltbank] ✗ sandbox configuration failed: ' + String(e));
    return false;
  }
}

// ─── sandbox recreate + gateway restart ──────────────────────────────────────

function recreateSandboxAndRestart(api: LoggerApi) {
  api.logger.info('[moltbank] recreating sandbox containers...');
  api.logger.info('[moltbank] ⏳ waiting 8s before recreate (hot container protection)...');
  setTimeout(() => {
    api.logger.info('[moltbank] stopping gateway...');
    run('openclaw gateway stop', { silent: true });

    const stillRunning = run("ps aux | grep openclaw-gateway | grep -v grep | awk '{print $2}'", { silent: true });
    if (stillRunning.stdout.trim()) {
      api.logger.info(`[moltbank] gateway still running (pids: ${stillRunning.stdout.trim()}) — sending SIGKILL...`);
      run("kill -9 $(ps aux | grep openclaw-gateway | grep -v grep | awk '{print $2}') 2>/dev/null || true", { silent: true });
      api.logger.info('[moltbank] ✓ gateway process killed');
    } else {
      api.logger.info('[moltbank] ✓ gateway stopped cleanly');
    }

    run('sleep 2', { silent: true });

    const recreate = run('openclaw sandbox recreate --all --force', {
      silent: false
    });
    if (recreate.ok) {
      api.logger.info('[moltbank] ✓ sandbox containers recreated — new container will be created on next agent message');
    } else {
      api.logger.warn('[moltbank] ✗ sandbox recreate failed');
      api.logger.warn('[moltbank]   run manually: openclaw sandbox recreate --all --force');
    }

    api.logger.info('[moltbank] restarting gateway...');
    run('openclaw gateway', { silent: true });
  }, 8000);
}

// ─── main setup ───────────────────────────────────────────────────────────────

async function runSetup(cfg: MoltbankPluginConfig, api: LoggerApi, options: { authWaitMode?: AuthWaitMode } = {}) {
  let hostReady = false;
  const appBaseUrl = getAppBaseUrl(cfg);
  const skillName = getSkillName(cfg);
  const sandbox = isSandboxEnabled();
  const skillDir = getSkillDir(cfg);
  const waitForAuth = (options.authWaitMode ?? 'blocking') === 'blocking';

  api.logger.info(`[moltbank] ══════════════════════════════════════`);
  api.logger.info(`[moltbank] MoltBank plugin setup starting`);
  api.logger.info(`[moltbank] mode:      ${sandbox ? 'sandbox (Docker)' : 'host (direct)'}`);
  api.logger.info(`[moltbank] skill dir: ${skillDir}`);
  api.logger.info(`[moltbank] base url:  ${appBaseUrl}`);
  api.logger.info(`[moltbank] ══════════════════════════════════════`);
  api.logger.info('[moltbank] preflight: cleaning stale MoltBank plugin load paths...');
  cleanupStaleMoltbankPluginLoadPaths(api);

  if (sandbox) {
    api.logger.info('[moltbank] configuring sandbox mode...');

    api.logger.info('[moltbank] [sandbox 0/10] ensuring mcporter on host...');
    ensureMcporter(api);

    api.logger.info('[moltbank] [sandbox 1/10] installing skill files...');
    const skillInstalled = ensureSkillInstalled(skillDir, appBaseUrl, skillName, api, 'sandbox');
    if (!skillInstalled) {
      api.logger.warn('[moltbank] skill install failed — aborting sandbox setup');
      return;
    }

    api.logger.info('[moltbank] [sandbox 2/10] ensuring SKILL.md naming...');
    ensureSkillFilesUppercase(skillDir, api);

    api.logger.info('[moltbank] [sandbox 3/10] applying permissions (chown + chmod)...');
    ensureSkillPermissions(skillDir, api);

    api.logger.info('[moltbank] [sandbox 4/10] ensuring sandbox authentication...');
    if (!ensureMoltbankAuth(skillDir, appBaseUrl, api, { waitForApproval: waitForAuth })) {
      if (!waitForAuth) {
        api.logger.warn('[moltbank] sandbox auth pending — startup continues without blocking channel startup');
        return;
      }
      api.logger.warn('[moltbank] sandbox auth not ready — complete onboarding and run setup again');
      return;
    }

    api.logger.info('[moltbank] [sandbox 5/10] installing skill npm dependencies...');
    ensureNpmDeps(skillDir, api, 'sandbox');

    api.logger.info('[moltbank] [sandbox 6/10] normalizing SKILL.md frontmatter...');
    fixSkillFrontmatter(skillDir, skillName, api);

    api.logger.info('[moltbank] [sandbox 7/10] writing/registering mcporter config...');
    ensureMcporterConfig(skillDir, appBaseUrl, api);

    api.logger.info('[moltbank] [sandbox 8/10] configuring sandbox docker settings...');
    const sandboxChanged = configureSandbox(api);

    api.logger.info('[moltbank] [sandbox 9/10] injecting sandbox env vars (MOLTBANK, ACTIVE_ORG_OVERRIDE, SIGNER)...');
    const envChanged = injectSandboxEnv(skillDir, api);

    api.logger.info('[moltbank] [sandbox 10/10] apply sandbox changes (recreate + gateway stop)...');
    if (sandboxChanged || envChanged) {
      api.logger.info('[moltbank] config changed — recreating sandbox to apply new settings');
      recreateSandboxAndRestart(api);
    } else {
      api.logger.info('[moltbank] sandbox unchanged — no restart needed');
    }
  } else {
    api.logger.info('[moltbank] [host 1/8] ensuring mcporter on host...');
    ensureMcporter(api);

    api.logger.info('[moltbank] [host 2/8] installing skill files...');
    const installed = ensureSkillInstalled(skillDir, appBaseUrl, skillName, api, 'host');
    if (!installed) {
      api.logger.warn('[moltbank] host setup aborted: skill install failed. Verify install.sh/base URL and retry.');
      return;
    }

    api.logger.info('[moltbank] [host 3/8] ensuring SKILL.md naming/frontmatter...');
    ensureSkillFilesUppercase(skillDir, api);
    fixSkillFrontmatter(skillDir, skillName, api);

    api.logger.info('[moltbank] [host 4/8] applying permissions (chown + chmod)...');
    ensureSkillPermissions(skillDir, api);

    api.logger.info('[moltbank] [host 5/8] ensuring account onboarding/authentication...');
    if (!ensureMoltbankAuth(skillDir, appBaseUrl, api, { waitForApproval: waitForAuth })) {
      if (!waitForAuth) {
        api.logger.warn('[moltbank] host auth pending — startup continues without blocking channel startup');
        return;
      }
      api.logger.warn('[moltbank] host auth not ready — complete onboarding and run setup again');
      return;
    }

    api.logger.info('[moltbank] [host 6/8] installing skill npm dependencies...');
    ensureNpmDeps(skillDir, api, 'host');

    api.logger.info('[moltbank] [host 7/8] writing/registering mcporter config...');
    ensureMcporterConfig(skillDir, appBaseUrl, api);

    api.logger.info('[moltbank] [host 8/8] running wrapper smoke test...');
    // FIX: usar path absoluto para el .ps1 en Windows
    const ps1Path = join(skillDir, 'scripts', 'moltbank.ps1');
    const smokeCmd = IS_WIN
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}" list MoltBank`
      : `"${skillDir}/scripts/moltbank.sh" list MoltBank`;
    const smoke = run(smokeCmd, { cwd: skillDir, silent: true });
    if (!smoke.ok) {
      api.logger.warn('[moltbank] host setup incomplete: smoke test failed (`moltbank list MoltBank` via platform script)');
    } else {
      api.logger.info('[moltbank] host smoke test passed (`moltbank list MoltBank`)');
    }
    hostReady = smoke.ok;

    api.logger.info('[moltbank] host mode — setup completed with onboarding flow');
  }

  api.logger.info(`[moltbank] ══════════════════════════════════════`);
  api.logger.info(`[moltbank] ✓ setup complete`);
  if (sandbox) {
    api.logger.info('[moltbank] ⏳ sandbox will be recreated in ~8s — send a message to the agent after that');
  } else if (hostReady) {
    api.logger.info('[moltbank] ✓ host ready');
  }
  api.logger.info(`[moltbank]   skill:    ${skillDir}/SKILL.md`);
  api.logger.info(`[moltbank]   mcporter: ${skillDir}/config/mcporter.json`);
  if (sandbox) {
    const finalConfig = readOpenclawConfig();
    const finalEnv = asStringRecord(getNestedValue(finalConfig, ['agents', 'defaults', 'sandbox', 'docker', 'env']));
    const finalNetwork = asString(getNestedValue(finalConfig, ['agents', 'defaults', 'sandbox', 'docker', 'network']));
    const finalCmd = asString(getNestedValue(finalConfig, ['agents', 'defaults', 'sandbox', 'docker', 'setupCommand']));

    api.logger.info(`[moltbank]   openclaw.json sandbox env:`);
    api.logger.info(`[moltbank]     MOLTBANK:             ${finalEnv.MOLTBANK ? '✓ set' : '✗ missing'}`);
    api.logger.info(
      `[moltbank]     ACTIVE_ORG_OVERRIDE:  ${finalEnv.ACTIVE_ORG_OVERRIDE ? `✓ "${finalEnv.ACTIVE_ORG_OVERRIDE}"` : '✗ missing'}`
    );
    api.logger.info(`[moltbank]     SIGNER:               ${finalEnv.SIGNER ? '✓ set' : '✗ missing (agent may generate on first use)'}`);
    api.logger.info(`[moltbank]   sandbox docker:`);
    api.logger.info(
      `[moltbank]     network:              ${finalNetwork === 'bridge' ? '✓ bridge' : `✗ "${finalNetwork}" (expected bridge)`}`
    );
    api.logger.info(
      `[moltbank]     setupCommand:         ${finalCmd.includes('node_22.x') && !finalCmd.includes('/home/') ? '✓ ok (no host paths)' : '✗ may be corrupted'}`
    );

    const containerCheck = run(
      `docker inspect $(docker ps | grep openclaw-sbx | awk '{print $1}') --format '{{.HostConfig.NetworkMode}}' 2>/dev/null`,
      { silent: true }
    );
    if (!containerCheck.ok || !containerCheck.stdout) {
      api.logger.info(`[moltbank]   container: not running yet — will be created on first agent message`);
    } else if (containerCheck.stdout.trim() === 'bridge') {
      api.logger.info(`[moltbank]   container: ✓ bridge network — internet available`);
    } else {
      api.logger.warn(`[moltbank]   container: ✗ network "${containerCheck.stdout.trim()}" — NO INTERNET`);
      api.logger.warn(`[moltbank]   agent cannot reach MoltBank — stop gateway, reinstall plugin, run openclaw gateway`);
    }
  }
  api.logger.info(`[moltbank] ══════════════════════════════════════`);
}

// ─── plugin register ──────────────────────────────────────────────────────────

export default function register(api: PluginApi) {
  const cfg: MoltbankPluginConfig = api.config?.plugins?.entries?.moltbank?.config ?? {};

  api.registerService({
    id: 'moltbank-setup',
    start: async () => {
      await runSetup(cfg, api, { authWaitMode: 'nonblocking' });
    },
    stop: async () => {
      api.logger.info('[moltbank] plugin stopped');
    }
  });

  api.registerCli(
    ({ program }: { program: CliCommandLike }) => {
      program
        .command('moltbank')
        .description('MoltBank plugin commands')
        .addCommand(
          program
            .createCommand('setup')
            .description('Re-run MoltBank setup (nonblocking auth by default)')
            .action(async () => {
              console.log('Running MoltBank setup...');
              const authWaitMode = getSetupAuthWaitMode('nonblocking');
              if (authWaitMode === 'nonblocking') {
                console.log('[moltbank] setup auth mode: nonblocking (default for channel reliability)');
                console.log('[moltbank] set MOLTBANK_SETUP_AUTH_WAIT_MODE=blocking to wait for OAuth approval');
              } else {
                console.log('[moltbank] setup auth mode: blocking (waiting for OAuth approval)');
              }
              await runSetup(cfg, { logger: console }, { authWaitMode });
            })
        )
        .addCommand(
          program
            .createCommand('setup-blocking')
            .description('Re-run full MoltBank setup and wait for OAuth approval')
            .action(async () => {
              console.log('Running MoltBank setup (blocking auth mode)...');
              await runSetup(cfg, { logger: console }, { authWaitMode: 'blocking' });
            })
        )
        .addCommand(
          program
            .createCommand('sandbox-setup')
            .description('Reconfigure sandbox docker in openclaw.json')
            .action(() => {
              const changed = configureSandbox({ logger: console });
              if (changed) {
                recreateSandboxAndRestart({ logger: console });
              } else {
                console.log('[moltbank] No sandbox docker changes — not scheduling teardown');
              }
            })
        )
        .addCommand(
          program
            .createCommand('inject-key')
            .description('Re-inject sandbox env vars from credentials.json')
            .action(() => {
              const skillDir = getSkillDir(cfg);
              const changed = injectSandboxEnv(skillDir, { logger: console });
              if (changed) {
                recreateSandboxAndRestart({ logger: console });
              } else {
                console.log('[moltbank] No env changes — not scheduling teardown');
              }
            })
        )
        .addCommand(
          program
            .createCommand('register')
            .description('Re-register mcporter server')
            .action(() => {
              const appBaseUrl = getAppBaseUrl(cfg);
              const skillDir = getSkillDir(cfg);
              ensureMcporterConfig(skillDir, appBaseUrl, { logger: console });
            })
        );
    },
    { commands: ['moltbank'] }
  );
}
