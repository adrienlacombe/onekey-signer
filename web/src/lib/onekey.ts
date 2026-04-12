/**
 * OneKey hardware wallet integration.
 * Connects via WebUSB, reads Bitcoin public keys, and signs messages.
 */
import SDK from '@onekeyfe/hd-web-sdk';
const HardwareSDK = SDK.HardwareWebSdk;
import { getBtcDerivationPath } from '../config/constants';

let sdkInitialized = false;
let currentConnectId: string | null = null;
let currentDeviceId: string | null = null;

export async function initOneKeySDK(): Promise<void> {
  if (sdkInitialized) return;
  await HardwareSDK.init({
    debug: false,
    connectSrc: 'https://jssdk.onekey.so/0.3.49/',
    fetchConfig: true,
  });
  sdkInitialized = true;
}

export async function connectOneKey(): Promise<{
  connectId: string;
  deviceId: string;
}> {
  await initOneKeySDK();
  const result = await HardwareSDK.searchDevices();
  if (!result.success || !result.payload?.length) {
    throw new Error('No OneKey device found. Make sure it is connected and unlocked.');
  }
  const device = result.payload[0];
  currentConnectId = device.connectId ?? null;
  currentDeviceId = device.deviceId ?? null;
  if (!currentConnectId || !currentDeviceId) {
    throw new Error('Device connection failed — missing connectId or deviceId');
  }
  return { connectId: currentConnectId, deviceId: currentDeviceId };
}

export async function getBtcPublicKey(accountIndex: number = 0): Promise<{
  publicKey: string;
}> {
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
    throw new Error(`btcGetPublicKey failed: ${(result.payload as any)?.error || 'unknown'}`);
  }
  const payload = result.payload as any;
  return { publicKey: payload.node?.public_key || payload.publicKey || '' };
}

export async function signWithOneKey(
  messageHex: string,
  accountIndex: number = 0,
): Promise<{ v: number; r: string; s: string }> {
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
    throw new Error(`btcSignMessage failed: ${(result.payload as any)?.error || 'unknown'}`);
  }
  const payload = result.payload as any;
  // OneKey returns base64-encoded 65-byte compact signature
  const sigBytes = Uint8Array.from(atob(payload.signature), (c) => c.charCodeAt(0));
  const byte0 = sigBytes[0];
  // byte0 = 27 + recovery_id + 4(compressed) + script_type_offset
  const recovery = (byte0 - 27 - 4) % 4; // strip compressed flag, get recovery mod 4
  const v = recovery >= 0 ? recovery : 0;
  const r = Array.from(sigBytes.slice(1, 33)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const s = Array.from(sigBytes.slice(33, 65)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { v, r, s };
}

export function disconnectOneKey(): void {
  currentConnectId = null;
  currentDeviceId = null;
}

export function isOneKeyConnected(): boolean {
  return currentConnectId !== null && currentDeviceId !== null;
}
