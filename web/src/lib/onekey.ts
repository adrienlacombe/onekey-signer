/**
 * OneKey hardware wallet integration.
 * Uses the official WebUSB flow for physical devices and a local transport for the simulator.
 */
import SDK from '@onekeyfe/hd-web-sdk';
import { getBtcDerivationPath } from '../config/constants';
import {
  ONEKEY_SIMULATOR_API_BASE,
  ONEKEY_SIMULATOR_ENABLED,
  ONEKEY_SIMULATOR_REVIEW_URL,
} from '../config/constants';

const HardwareSDK = SDK.HardwareSDKLowLevel;
const ONEKEY_WEBUSB_FILTER = [
  { vendorId: 0x1209, productId: 0x53c0 },
  { vendorId: 0x1209, productId: 0x53c1 },
  { vendorId: 0x1209, productId: 0x4f4a },
  { vendorId: 0x1209, productId: 0x4f4b },
];

const UI_EVENT = 'UI_EVENT';
const UI_REQUEST_PIN = 'ui-request_pin';
const UI_REQUEST_PASSPHRASE = 'ui-request_passphrase';
const UI_REQUEST_PASSPHRASE_ON_DEVICE = 'ui-request_passphrase_on_device';
const UI_RESPONSE_PIN = 'ui-receive_pin';
const UI_RESPONSE_PASSPHRASE = 'ui-receive_passphrase';
const PIN_ON_DEVICE_SENTINEL = '@@ONEKEY_INPUT_PIN_IN_DEVICE';

let sdkInitialized = false;
let sdkEventsBound = false;
let currentConnectId: string | null = null;
let currentDeviceId: string | null = null;

function sdkPayloadError(payload: unknown): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const error = record.error ?? record.message;
    if (typeof error === 'string') return error;
    if (error) return String(error);
  }
  return String(payload);
}

function isTransportFramingError(message: string): boolean {
  return /expected header signature|initialize failed/i.test(message);
}

function resetCurrentDevice(): void {
  if (currentConnectId) {
    try {
      HardwareSDK.cancel(currentConnectId);
    } catch {
      // Best-effort cleanup; the next connect will rebuild the device handle.
    }
  }
  currentConnectId = null;
  currentDeviceId = null;
}

function oneKeyOperationError(operation: string, payload: unknown): Error {
  const message = sdkPayloadError(payload) || 'unknown';
  if (isTransportFramingError(message)) {
    resetCurrentDevice();
    return new Error(
      `${operation} failed: ${message}. Reset the WebUSB session by closing other OneKey tabs/apps, unplugging and reconnecting the device, unlocking it, opening the Bitcoin app, then clicking Connect again.`,
    );
  }
  return new Error(`${operation} failed: ${message}`);
}

function decodeSignatureBytes(signature: string): Uint8Array {
  const trimmed = signature.trim();
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;

  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }

  return Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
}

async function simulatorRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ONEKEY_SIMULATOR_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });

  const payload = (await response.json()) as { error?: string } & T;
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Simulator request failed for ${path}`);
  }

  return payload;
}

export function isOneKeySimulatorModeEnabled(): boolean {
  return ONEKEY_SIMULATOR_ENABLED;
}

function supportsBrowserWebUsb(): boolean {
  if (typeof navigator === 'undefined') return false;
  const browserNavigator = navigator as Navigator & { usb?: unknown };
  return typeof browserNavigator.usb !== 'undefined';
}

function bindOneKeyUiEvents(): void {
  if (sdkEventsBound) return;

  HardwareSDK.addHardwareGlobalEventListener(async (message: any) => {
    if (message?.event !== UI_EVENT) return;

    switch (message?.type) {
      case UI_REQUEST_PIN:
        await HardwareSDK.uiResponse({
          type: UI_RESPONSE_PIN,
          payload: PIN_ON_DEVICE_SENTINEL,
        });
        break;
      case UI_REQUEST_PASSPHRASE:
      case UI_REQUEST_PASSPHRASE_ON_DEVICE:
        await HardwareSDK.uiResponse({
          type: UI_RESPONSE_PASSPHRASE,
          payload: { passphraseOnDevice: true, value: '' },
        });
        break;
      default:
        break;
    }
  });

  sdkEventsBound = true;
}

export async function initOneKeySDK(): Promise<void> {
  if (ONEKEY_SIMULATOR_ENABLED) return;
  if (sdkInitialized) return;
  if (!supportsBrowserWebUsb()) {
    throw new Error('WebUSB requires Chrome or Edge on desktop.');
  }

  bindOneKeyUiEvents();
  const initialized = await HardwareSDK.init({
    env: 'webusb',
    debug: false,
    fetchConfig: true,
  });

  if (!initialized) {
    throw new Error('Failed to initialize the OneKey WebUSB SDK.');
  }

  sdkInitialized = true;
}

async function authorizeBrowserWebUsb(): Promise<void> {
  const browserNavigator = navigator as Navigator & {
    usb?: {
      requestDevice(options: { filters: Array<{ vendorId: number; productId: number }> }): Promise<unknown>;
    };
  };

  if (!browserNavigator.usb) {
    throw new Error('WebUSB is not available in this browser.');
  }

  try {
    await browserNavigator.usb.requestDevice({ filters: ONEKEY_WEBUSB_FILTER });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel|abort|dismiss/i.test(message)) {
      throw new Error('The WebUSB device chooser was dismissed.');
    }
    throw error;
  }
}

function setCurrentDevice(device: {
  connectId?: string | null;
  deviceId?: string | null;
}): { connectId: string; deviceId: string } {
  currentConnectId = device.connectId ?? null;
  currentDeviceId = device.deviceId ?? null;

  if (!currentConnectId) {
    throw new Error('Device connection failed — missing connectId');
  }
  if (!currentDeviceId) {
    throw new Error('OneKey connected but device_id is unavailable. Unlock it and open the Bitcoin app, then try again.');
  }

  return { connectId: currentConnectId, deviceId: currentDeviceId };
}

async function discoverAuthorizedDevice(): Promise<{
  connectId: string;
  deviceId: string;
}> {
  const searchResult = await HardwareSDK.searchDevices();
  if (!searchResult.success) {
    throw oneKeyOperationError('OneKey device search', searchResult.payload);
  }

  const device = searchResult.payload?.[0];
  if (!device?.connectId) {
    throw new Error('No authorized OneKey device found. Approve the USB chooser, unlock the device, and open the Bitcoin app.');
  }

  if (device.deviceId) {
    return setCurrentDevice(device);
  }

  const features = await HardwareSDK.getFeatures(device.connectId);
  if (!features.success) {
    throw oneKeyOperationError('getFeatures', features.payload);
  }

  return setCurrentDevice({
    connectId: device.connectId,
    deviceId: (features.payload as any)?.device_id ?? null,
  });
}

export async function connectOneKey(): Promise<{
  connectId: string;
  deviceId: string;
}> {
  if (ONEKEY_SIMULATOR_ENABLED) {
    const device = await simulatorRequest<{
      connectId?: string;
      deviceId?: string;
    }>('/connect');
    currentConnectId = device.connectId ?? 'simulator';
    currentDeviceId = device.deviceId ?? null;
    if (!currentDeviceId) {
      throw new Error(
        `Simulator connection failed. Open ${ONEKEY_SIMULATOR_REVIEW_URL} and make sure the emulator is running.`,
      );
    }
    return { connectId: currentConnectId, deviceId: currentDeviceId };
  }

  await initOneKeySDK();
  await authorizeBrowserWebUsb();
  return discoverAuthorizedDevice();
}

export async function getBtcPublicKey(accountIndex: number = 0): Promise<{
  publicKey: string;
}> {
  if (ONEKEY_SIMULATOR_ENABLED) {
    if (!currentDeviceId) {
      throw new Error('OneKey not connected');
    }
    return simulatorRequest<{ publicKey: string }>('/public-key', { accountIndex });
  }

  if (!currentConnectId || !currentDeviceId) {
    throw new Error('OneKey not connected');
  }

  const path = getBtcDerivationPath(accountIndex);
  const result = await HardwareSDK.btcGetPublicKey(currentConnectId, currentDeviceId, {
    path,
    showOnOneKey: false,
    coin: 'btc',
  });
  if (!result.success) {
    throw oneKeyOperationError('btcGetPublicKey', result.payload);
  }
  const payload = result.payload as any;
  return { publicKey: payload.node?.public_key || payload.publicKey || '' };
}

export async function signWithOneKey(
  messageHex: string,
  accountIndex: number = 0,
): Promise<{ v: number; r: string; s: string }> {
  if (ONEKEY_SIMULATOR_ENABLED) {
    if (!currentDeviceId) {
      throw new Error('OneKey not connected');
    }
    return simulatorRequest<{ v: number; r: string; s: string }>('/sign-message', {
      accountIndex,
      messageHex,
    });
  }

  if (!currentConnectId || !currentDeviceId) {
    throw new Error('OneKey not connected');
  }

  const path = getBtcDerivationPath(accountIndex);
  const result = await HardwareSDK.btcSignMessage(currentConnectId, currentDeviceId, {
    path,
    messageHex,
    coin: 'btc',
  });
  if (!result.success) {
    throw oneKeyOperationError('btcSignMessage', result.payload);
  }
  const payload = result.payload as any;
  const sigBytes = decodeSignatureBytes(String(payload.signature || ''));
  if (sigBytes.length !== 65) {
    throw new Error(`Unexpected OneKey signature length: expected 65 bytes, got ${sigBytes.length}.`);
  }
  const byte0 = sigBytes[0];
  // byte0 = 27 + recovery_id + 4(compressed) + script_type_offset
  const recovery = (byte0 - 27 - 4) % 4;
  const v = recovery >= 0 ? recovery : 0;
  const r = Array.from(sigBytes.slice(1, 33))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const s = Array.from(sigBytes.slice(33, 65))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { v, r, s };
}

export function disconnectOneKey(): void {
  currentConnectId = null;
  currentDeviceId = null;
}

export function isOneKeyConnected(): boolean {
  return currentConnectId !== null && currentDeviceId !== null;
}
