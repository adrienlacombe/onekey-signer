import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginOption } from 'vite';

const DEFAULT_API_BASE = '/__onekey_simulator__';
const DEFAULT_CONTAINER = 'onekey-emu-1s';
const DEFAULT_DEVICE_LABEL = 'OneKey Classic';
const DEFAULT_DEVICE_LANGUAGE = 'en';
const DEFAULT_DEVICE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const DEFAULT_PYTHONPATH = '/home/firmware-classic1s/python/src';
const DEFAULT_PYTHON_BIN = '/.venv/bin/python';
const DEFAULT_UDP_ENDPOINT = '127.0.0.1:54935';
const DEFAULT_BOOT_WAIT_MS = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const BOOL_TRUE_RE = /^(1|true|yes|on)$/i;

interface OneKeySimulatorPluginOptions {
  apiBase?: string;
  bootWaitMs?: number;
  containerName?: string;
  enabled?: boolean;
  pythonPath?: string;
  pythonBin?: string;
  requestTimeoutMs?: number;
  udpEndpoint?: string;
}

interface ParsedBody {
  accountIndex?: unknown;
  messageHex?: unknown;
}

let transportLock: Promise<void> = Promise.resolve();

function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function isHexString(value: string): boolean {
  return /^(0x)?[0-9a-f]+$/i.test(value);
}

function normalizeMessageHex(messageHex: string): string {
  const clean = messageHex.trim().replace(/^0x/i, '');
  if (!clean || !isHexString(clean)) {
    throw new Error('messageHex must be a non-empty hex string.');
  }
  return clean.length % 2 === 0 ? clean.toLowerCase() : `0${clean.toLowerCase()}`;
}

function parseAccountIndex(body: ParsedBody): number {
  const raw = body.accountIndex;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? 0), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('accountIndex must be a non-negative integer.');
  }
  return parsed;
}

function getBtcDerivationPathArray(accountIndex: number): number[] {
  return [0x8000002c, 0x80000000, 0x80000000, 0, accountIndex];
}

function buildPythonScript(scriptBody: string, udpEndpoint: string): string {
  return [
    'import base64',
    'import json',
    'import os',
    'from trezorlib import btc, messages',
    'from trezorlib.debuglink import TrezorClientDebugLink',
    'from trezorlib.transport import udp',
    `transport = udp.UdpTransport("${udpEndpoint}")`,
    'client = TrezorClientDebugLink(transport)',
    'client.init_device()',
    'path = json.loads(os.environ["ONEKEY_PATH_JSON"]) if os.environ.get("ONEKEY_PATH_JSON") else None',
    'try:',
    scriptBody,
    'finally:',
    '    client.close()',
    '',
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTransportLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = transportLock.catch(() => {});
  let release!: () => void;
  transportLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

async function runSimulatorPython(options: {
  containerName: string;
  env?: Record<string, string>;
  pythonBin: string;
  pythonPath: string;
  requestTimeoutMs: number;
  scriptBody: string;
  udpEndpoint: string;
}): Promise<Record<string, unknown>> {
  const script = buildPythonScript(options.scriptBody, options.udpEndpoint);
  const envEntries = Object.entries(options.env ?? {});

  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      ...envEntries.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      options.containerName,
      'bash',
      '-lc',
      `cd / && PYTHONUNBUFFERED=1 PYTHONPATH=${options.pythonPath} timeout --signal=TERM ${Math.max(1, Math.ceil(options.requestTimeoutMs / 1000))}s ${options.pythonBin} -u -`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, options.requestTimeoutMs);

  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        if (code === 124 || code === 143) {
          reject(
            new Error(
              `Simulator transport timed out after ${options.requestTimeoutMs}ms. ` +
                `The emulator may be busy or the bridge may be stuck.`,
            ),
          );
          return;
        }
        reject(
          new Error(
            `Simulator transport failed with exit code ${code}: ${(stderr || stdout).trim() || 'no output'}`,
          ),
        );
        return;
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const lastLine = lines.at(-1);

      if (!lastLine) {
        reject(new Error(`Simulator transport returned no output. Stderr: ${stderr.trim() || 'empty'}`));
        return;
      }

      try {
        resolve(JSON.parse(lastLine) as Record<string, unknown>);
      } catch (error) {
        reject(
          new Error(
            `Simulator transport returned invalid JSON: ${String(error)}. Output: ${stdout.trim() || 'empty'}`,
          ),
        );
      }
    });
  });

  child.stdin.write(script);
  child.stdin.end();

  return result;
}

async function cleanupStaleTransportProcesses(containerName: string): Promise<void> {
  const result = await runCommand('docker', [
    'exec',
    containerName,
    'bash',
    '-lc',
    "pkill -f '/\\.venv/bin/python .* -u -' >/dev/null 2>&1 || true",
  ]);

  if (result.code !== 0) {
    throw new Error(
      `Failed to clean up stale OneKey transport helpers in ${containerName}: ${(result.stderr || result.stdout).trim() || 'no output'}`,
    );
  }
}

async function stopEmulatorProcesses(containerName: string): Promise<void> {
  const result = await runCommand('docker', [
    'exec',
    containerName,
    'bash',
    '-lc',
    "ps -eo pid=,args= | awk '/\\.\\/onekey_emu\\.elf/ {print $1}' | xargs -r kill -TERM",
  ]);

  if (result.code !== 0) {
    throw new Error(
      `Failed to stop the OneKey emulator process in ${containerName}: ${(result.stderr || result.stdout).trim() || 'no output'}`,
    );
  }
}

function getSimulatorMnemonic(): string {
  return (
    process.env.ONEKEY_SIMULATOR_MNEMONIC?.trim() ||
    process.env.ONEKEY_EMULATOR_MNEMONIC?.trim() ||
    DEFAULT_DEVICE_MNEMONIC
  );
}

function getSimulatorLanguage(): string {
  return process.env.ONEKEY_SIMULATOR_LANGUAGE?.trim() || DEFAULT_DEVICE_LANGUAGE;
}

function getSimulatorLabel(): string {
  return process.env.ONEKEY_SIMULATOR_LABEL?.trim() || DEFAULT_DEVICE_LABEL;
}

function shouldRecoverTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('ConnectionRefusedError') ||
    message.includes('returned no output') ||
    message.includes('timed out after')
  );
}

async function startHeadlessEmulator(containerName: string): Promise<void> {
  const result = await runCommand('docker', [
    'exec',
    containerName,
    'bash',
    '-lc',
    [
      'mkdir -p /tmp/runtime-root',
      'cd /home/firmware-classic1s/legacy/firmware',
      'nohup env SDL_VIDEODRIVER=dummy XDG_RUNTIME_DIR=/tmp/runtime-root ./onekey_emu.elf >/tmp/onekey-emu-headless.log 2>&1 </dev/null &',
    ].join('\n'),
  ]);

  if (result.code !== 0) {
    throw new Error(
      `Failed to start the OneKey emulator process inside ${containerName}: ${(result.stderr || result.stdout).trim() || 'no output'}`,
    );
  }
}

async function isDebugUdpReady(containerName: string): Promise<boolean> {
  const result = await runCommand('docker', [
    'exec',
    containerName,
    'bash',
    '-lc',
    'netstat -lntup 2>/dev/null || ss -lntup',
  ]);

  if (result.code !== 0) {
    return false;
  }

  return result.stdout.includes(':54935');
}

async function waitForDebugUdp(containerName: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isDebugUdpReady(containerName)) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for the OneKey emulator debug UDP port to open in ${containerName}.`);
}

async function runSimulatorPythonWithRecovery(
  options: Parameters<typeof runSimulatorPython>[0],
  bootWaitMs: number,
): Promise<Record<string, unknown>> {
  try {
    return await runSimulatorPython(options);
  } catch (error) {
    if (!shouldRecoverTransport(error)) {
      throw error;
    }

    await cleanupStaleTransportProcesses(options.containerName);
    await stopEmulatorProcesses(options.containerName);
    await startHeadlessEmulator(options.containerName);
    await waitForDebugUdp(options.containerName, bootWaitMs);
    return runSimulatorPython(options);
  }
}

async function ensureSimulatorInitialized(options: {
  bootWaitMs: number;
  containerName: string;
  pythonBin: string;
  pythonPath: string;
  requestTimeoutMs: number;
  udpEndpoint: string;
}): Promise<void> {
  await runSimulatorPythonWithRecovery(
    {
      containerName: options.containerName,
      env: {
        ONEKEY_LANGUAGE: getSimulatorLanguage(),
        ONEKEY_LABEL: getSimulatorLabel(),
        ONEKEY_MNEMONIC: getSimulatorMnemonic(),
      },
      pythonBin: options.pythonBin,
      pythonPath: options.pythonPath,
      requestTimeoutMs: options.requestTimeoutMs,
      scriptBody: [
        '    from trezorlib import debuglink',
        '    if not client.features.initialized:',
        '        debuglink.load_device_by_mnemonic(',
        '            client,',
        '            os.environ["ONEKEY_MNEMONIC"],',
        '            pin=None,',
        '            passphrase_protection=False,',
        '            label=os.environ.get("ONEKEY_LABEL") or None,',
        '            language=os.environ.get("ONEKEY_LANGUAGE") or "en",',
        '        )',
        '        client.init_device()',
        '    print(json.dumps({"initialized": client.features.initialized}))',
      ].join('\n'),
      udpEndpoint: options.udpEndpoint,
    },
    options.bootWaitMs,
  );
}

async function containerExists(containerName: string): Promise<boolean> {
  const result = await runCommand('docker', ['ps', '--filter', `name=^${containerName}$`, '--format', '{{.Names}}']);
  if (result.code !== 0) {
    throw new Error(`Failed to query Docker containers: ${(result.stderr || result.stdout).trim() || 'no output'}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(containerName);
}

async function detectSimulatorContainer(): Promise<string> {
  const candidates: Array<{ args: string[]; description: string }> = [
    {
      args: ['ps', '--filter', 'publish=21333', '--format', '{{.Names}}'],
      description: 'published bridge port 21333',
    },
    {
      args: ['ps', '--filter', 'ancestor=ok-emu:latest', '--format', '{{.Names}}'],
      description: 'ok-emu:latest image',
    },
  ];

  for (const candidate of candidates) {
    const result = await runCommand('docker', candidate.args);
    if (result.code !== 0) {
      throw new Error(
        `Failed to query Docker containers by ${candidate.description}: ${(result.stderr || result.stdout).trim() || 'no output'}`,
      );
    }

    const names = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (names.length > 0) {
      return names[0]!;
    }
  }

  throw new Error(
    'No running OneKey simulator container found. Start the emulator first and make sure port 21333 is published.',
  );
}

async function resolveContainerName(preferredName: string): Promise<string> {
  if (preferredName && (await containerExists(preferredName))) {
    return preferredName;
  }

  return detectSimulatorContainer();
}

async function readJsonBody(req: IncomingMessage): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw) as ParsedBody;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parseSignature(signatureBase64: string) {
  const sigBytes = Buffer.from(signatureBase64, 'base64');
  const byte0 = sigBytes[0] ?? 0;
  const recovery = (byte0 - 27 - 4) % 4;
  const v = recovery >= 0 ? recovery : 0;
  const r = sigBytes.slice(1, 33).toString('hex');
  const s = sigBytes.slice(33, 65).toString('hex');
  return { v, r, s };
}

export function onekeySimulatorPlugin(
  options: OneKeySimulatorPluginOptions = {},
): PluginOption {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const bootWaitMs = options.bootWaitMs ?? DEFAULT_BOOT_WAIT_MS;
  const enabled = options.enabled ?? false;
  const containerName = options.containerName ?? DEFAULT_CONTAINER;
  const pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
  const pythonPath = options.pythonPath ?? DEFAULT_PYTHONPATH;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const udpEndpoint = options.udpEndpoint ?? DEFAULT_UDP_ENDPOINT;

  return {
    name: 'onekey-simulator-dev-api',
    apply: 'serve',
    configureServer(server) {
      if (!enabled) return;

      server.middlewares.use(async (req, res, next) => {
        const method = req.method ?? 'GET';
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

        if (!pathname.startsWith(apiBase)) {
          next();
          return;
        }

        try {
          await withTransportLock(async () => {
          if (method === 'POST' && pathname === `${apiBase}/connect`) {
            const resolvedContainerName = await resolveContainerName(containerName);
            await ensureSimulatorInitialized({
              bootWaitMs,
              containerName: resolvedContainerName,
              pythonBin,
              pythonPath,
              requestTimeoutMs,
              udpEndpoint,
            });
            const payload = await runSimulatorPythonWithRecovery(
              {
                containerName: resolvedContainerName,
                pythonPath,
                pythonBin,
                requestTimeoutMs,
                scriptBody: [
                  '    print(json.dumps({',
                  '        "connectId": "simulator",',
                  '        "deviceId": getattr(client.features, "device_id", None),',
                  '        "label": client.features.label,',
                  '        "language": getattr(client.features, "language", None),',
                  '        "initialized": client.features.initialized,',
                  '        "model": client.features.model,',
                  '    }))',
                ].join('\n'),
                udpEndpoint,
              },
              bootWaitMs,
            );
            sendJson(res, 200, payload);
            return;
          }

          if (method === 'POST' && pathname === `${apiBase}/public-key`) {
            const body = await readJsonBody(req);
            const accountIndex = parseAccountIndex(body);
            const resolvedContainerName = await resolveContainerName(containerName);
            await ensureSimulatorInitialized({
              bootWaitMs,
              containerName: resolvedContainerName,
              pythonBin,
              pythonPath,
              requestTimeoutMs,
              udpEndpoint,
            });
            const payload = await runSimulatorPythonWithRecovery(
              {
                containerName: resolvedContainerName,
                env: {
                  ONEKEY_PATH_JSON: JSON.stringify(getBtcDerivationPathArray(accountIndex)),
                },
                pythonPath,
                pythonBin,
                requestTimeoutMs,
                scriptBody: [
                  '    response = btc.get_public_node(',
                  '        client,',
                  '        path,',
                  '        coin_name="Bitcoin",',
                  '        script_type=messages.InputScriptType.SPENDADDRESS,',
                  '    )',
                  '    print(json.dumps({"publicKey": response.node.public_key.hex()}))',
                ].join('\n'),
                udpEndpoint,
              },
              bootWaitMs,
            );
            sendJson(res, 200, payload);
            return;
          }

          if (method === 'POST' && pathname === `${apiBase}/sign-message`) {
            const body = await readJsonBody(req);
            const accountIndex = parseAccountIndex(body);
            const messageHex = normalizeMessageHex(String(body.messageHex ?? ''));
            const resolvedContainerName = await resolveContainerName(containerName);
            await ensureSimulatorInitialized({
              bootWaitMs,
              containerName: resolvedContainerName,
              pythonBin,
              pythonPath,
              requestTimeoutMs,
              udpEndpoint,
            });
            const payload = await runSimulatorPythonWithRecovery(
              {
                containerName: resolvedContainerName,
                env: {
                  ONEKEY_MESSAGE_HEX: messageHex,
                  ONEKEY_PATH_JSON: JSON.stringify(getBtcDerivationPathArray(accountIndex)),
                },
                pythonPath,
                pythonBin,
                requestTimeoutMs,
                scriptBody: [
                  '    response = btc.sign_message(',
                  '        client,',
                  '        "Bitcoin",',
                  '        path,',
                  '        bytes.fromhex(os.environ["ONEKEY_MESSAGE_HEX"]),',
                  '        script_type=messages.InputScriptType.SPENDADDRESS,',
                  '        no_script_type=False,',
                  '    )',
                  '    print(json.dumps({"signature": base64.b64encode(response.signature).decode("ascii")}))',
                ].join('\n'),
                udpEndpoint,
              },
              bootWaitMs,
            );

            sendJson(res, 200, parseSignature(String(payload.signature || '')));
            return;
          }

          sendJson(res, 404, { error: 'Simulator endpoint not found.' });
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 500, { error: message });
        }
      });
    },
  };
}

export function isSimulatorEnabled(rawValue: string | undefined): boolean {
  return BOOL_TRUE_RE.test(rawValue ?? '');
}
