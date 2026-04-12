import { ec, type RpcProvider } from 'starknet';

const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const MAX_PRIVATE_KEY = EC_ORDER / 2n - 1n;
const STRK_DECIMALS = 10n ** 18n;

type ApiSubchannelCursor = {
  note_discovery_complete?: boolean;
  last_note_index?: number;
  total_n_notes?: number;
};

type ApiChannelCursor = {
  channel_key?: string;
  subchannel_discovery_complete?: boolean;
  last_subchannel_index?: number;
  subchannels?: Record<string, ApiSubchannelCursor>;
};

type ApiDiscoveryCursor = {
  channel_discovery_complete?: boolean;
  total_n_channels?: number;
  last_channel_index?: number;
  channels?: Record<string, ApiChannelCursor>;
};

type ApiIncomingChannel = {
  channel_key: string;
  sender_addr: string;
};

type ApiIncomingNote = {
  sender_addr: string;
  token: string;
  index: number;
  note_id: string;
  amount: string;
  salt: string;
};

type ApiIncomingSyncResponse = {
  block_ref: string;
  channels: ApiIncomingChannel[];
  notes: ApiIncomingNote[];
  cursor: ApiDiscoveryCursor;
};

type ApiOutgoingChannel = {
  recipient_addr: string;
  recipient_public_key: string;
  channel_key: string;
  precomputed?: boolean;
};

type ApiOutgoingSubchannel = {
  recipient_addr: string;
  token: string;
  last_note_index: number | null;
};

type ApiOutgoingSyncResponse = {
  block_ref: string;
  channels: ApiOutgoingChannel[];
  subchannels: ApiOutgoingSubchannel[];
  cursor: ApiDiscoveryCursor;
};

export interface PrivatePoolNote {
  amount: bigint;
  channelKey: string;
  id: string;
  index: number;
  open: boolean;
  salt: string;
  sender: string;
  token: string;
}

export interface PrivatePoolSubchannel {
  lastNoteIndex: number | null;
  token: string;
}

export interface PrivatePoolOutgoingChannel {
  channelKey: string;
  precomputed: boolean;
  publicKey: string;
  recipient: string;
  subchannelCount: number;
  subchannels: Map<string, PrivatePoolSubchannel>;
}

export interface PrivatePoolState {
  blockRef: string | null;
  notes: PrivatePoolNote[];
  outgoingChannels: PrivatePoolOutgoingChannel[];
  totalOutgoingChannels: number;
}

export function normalizeHex(value: string | bigint | number): string {
  if (typeof value === 'string') {
    const clean = value.replace(/^0x/i, '').toLowerCase();
    if (!clean) return '0x0';
    if (!/^[0-9a-f]+$/.test(clean)) {
      throw new Error(`Invalid hex value: ${value}`);
    }
    const normalized = clean.replace(/^0+/, '');
    return '0x' + (normalized || '0');
  }
  return '0x' + BigInt(value).toString(16);
}

function isCursorComplete(cursor: ApiDiscoveryCursor | undefined): boolean {
  if (!cursor?.channel_discovery_complete) return false;
  if (!cursor.channels) return true;
  return Object.values(cursor.channels).every(
    (channel) =>
      channel.subchannel_discovery_complete &&
      (!channel.subchannels ||
        Object.values(channel.subchannels).every((subchannel) => !!subchannel.note_discovery_complete)),
  );
}

async function postIndexer<T>(apiUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Discovery ${path} failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

function shortStringToFelt(value: string): bigint {
  let result = 0n;
  for (let i = 0; i < value.length; i += 1) {
    result = (result << 8n) | BigInt(value.charCodeAt(i));
  }
  return result;
}

export function parseStrkInput(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d{0,18})?$/.test(trimmed)) {
    throw new Error('Enter a valid STRK amount.');
  }

  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  const whole = BigInt(wholePart);
  const fractional = BigInt((fractionalPart + '0'.repeat(18)).slice(0, 18) || '0');
  const amount = whole * STRK_DECIMALS + fractional;

  if (amount <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }

  return amount;
}

export function formatStrk(wei: bigint, precision: number = 6): string {
  const whole = wei / STRK_DECIMALS;
  const fraction = (wei % STRK_DECIMALS)
    .toString()
    .padStart(18, '0')
    .slice(0, precision);
  return `${whole}.${fraction}`;
}

export function derivePrivacyKey(pubkeyHash: string, address: string): string {
  const raw = ec.starkCurve.poseidonHashMany([BigInt(pubkeyHash), BigInt(address)]);
  const key = (BigInt('0x' + raw.toString(16)) % (MAX_PRIVATE_KEY - 1n)) + 1n;
  return normalizeHex(key);
}

export function computeChannelKey(
  senderAddress: string,
  senderPrivacyKey: string,
  recipientAddress: string,
  recipientPublicKey: string,
): string {
  const channelKey = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('CHANNEL_KEY_TAG:V1'),
    BigInt(senderAddress),
    BigInt(senderPrivacyKey),
    BigInt(recipientAddress),
    BigInt(recipientPublicKey),
  ]);
  return normalizeHex(channelKey);
}

function computeOutgoingChannelId(
  senderAddress: string,
  senderPrivacyKey: string,
  index: number,
): string {
  const result = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('OUTGOING_CHANNEL_ID_TAG:V1'),
    BigInt(senderAddress),
    BigInt(senderPrivacyKey),
    BigInt(index),
    0n,
  ]);
  return normalizeHex(result);
}

function computeNoteId(channelKey: string, token: string, index: number): string {
  const result = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('NOTE_ID_TAG:V1'),
    BigInt(channelKey),
    BigInt(token),
    BigInt(index),
    0n,
  ]);
  return normalizeHex(result);
}

export async function getNextChannelIndex(
  provider: RpcProvider,
  poolAddress: string,
  senderAddress: string,
  senderPrivacyKey: string,
): Promise<number> {
  for (let i = 0; i < 1000; i += 1) {
    const id = computeOutgoingChannelId(senderAddress, senderPrivacyKey, i);
    try {
      const info = await provider.callContract({
        contractAddress: poolAddress,
        entrypoint: 'get_outgoing_channel_info',
        calldata: [id],
      });
      if (info[0] === '0x0' || info[0] === '0') return i;
    } catch {
      return i;
    }
  }

  throw new Error('No available outgoing channel index found.');
}

export async function getNextNoteIndex(
  provider: RpcProvider,
  poolAddress: string,
  channelKey: string,
  token: string,
): Promise<number> {
  for (let i = 0; i < 1000; i += 1) {
    const noteId = computeNoteId(channelKey, token, i);
    try {
      const note = await provider.callContract({
        contractAddress: poolAddress,
        entrypoint: 'get_note',
        calldata: [noteId],
      });
      if (note[0] === '0x0' || note[0] === '0') return i;
    } catch {
      return i;
    }
  }

  throw new Error('No available note index found.');
}

export function randomFelt(): string {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return (
    '0x' +
    Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  );
}

export function generateRandom120(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  if (result <= 1n) result = 2n;
  return normalizeHex(result);
}

export async function discoverPrivatePoolState(args: {
  address: string;
  apiUrl: string;
  poolAddress: string;
  tokenAddress: string;
  viewingKey: string;
}): Promise<PrivatePoolState> {
  const { address, apiUrl, poolAddress, tokenAddress, viewingKey } = args;

  const notes: PrivatePoolNote[] = [];
  const knownChannelKeys = new Map<string, string>();
  let incomingBlockRef: string | null = null;
  let incomingCursor: ApiDiscoveryCursor = {};

  do {
    const response: ApiIncomingSyncResponse = await postIndexer<ApiIncomingSyncResponse>(
      apiUrl,
      '/v1/sync/incoming_state',
      {
        contract_address: normalizeHex(poolAddress),
        recipient_address: normalizeHex(address),
        viewing_key: normalizeHex(viewingKey),
        cursor: incomingCursor,
        ...(incomingBlockRef ? { block_ref: incomingBlockRef } : {}),
      },
    );

    incomingBlockRef = response.block_ref;

    for (const channel of response.channels) {
      knownChannelKeys.set(normalizeHex(channel.sender_addr), normalizeHex(channel.channel_key));
    }

    for (const note of response.notes) {
      if (normalizeHex(note.token) !== normalizeHex(tokenAddress)) continue;
      const sender = normalizeHex(note.sender_addr);
      const channelKey = knownChannelKeys.get(sender);
      if (!channelKey) {
        throw new Error(`Missing channel key for note sender ${sender}.`);
      }
      notes.push({
        amount: BigInt(note.amount),
        channelKey,
        id: normalizeHex(note.note_id),
        index: note.index,
        open: note.salt === '1',
        salt: normalizeHex(note.salt),
        sender,
        token: normalizeHex(note.token),
      });
    }

    incomingCursor = response.cursor ?? {};
  } while (!isCursorComplete(incomingCursor));

  const createdChannels = new Map<
    string,
    { channelKey: string; precomputed: boolean; publicKey: string }
  >();
  const subchannelsByRecipient = new Map<string, Map<string, PrivatePoolSubchannel>>();
  let outgoingBlockRef: string | null = null;
  let outgoingCursor: ApiDiscoveryCursor = { channel_discovery_complete: false };
  let totalOutgoingChannels = 0;

  do {
    const response: ApiOutgoingSyncResponse = await postIndexer<ApiOutgoingSyncResponse>(
      apiUrl,
      '/v1/sync/outgoing_state',
      {
        contract_address: normalizeHex(poolAddress),
        sender_address: normalizeHex(address),
        viewing_key: normalizeHex(viewingKey),
        cursor: outgoingCursor,
        ...(outgoingBlockRef ? { block_ref: outgoingBlockRef } : {}),
      },
    );

    outgoingBlockRef = response.block_ref;
    totalOutgoingChannels = Math.max(totalOutgoingChannels, response.cursor?.total_n_channels ?? 0);

    for (const channel of response.channels) {
      createdChannels.set(normalizeHex(channel.recipient_addr), {
        channelKey: normalizeHex(channel.channel_key),
        precomputed: !!channel.precomputed,
        publicKey: normalizeHex(channel.recipient_public_key),
      });
    }

    for (const subchannel of response.subchannels) {
      const recipient = normalizeHex(subchannel.recipient_addr);
      const token = normalizeHex(subchannel.token);
      const current = subchannelsByRecipient.get(recipient) ?? new Map<string, PrivatePoolSubchannel>();
      current.set(token, {
        lastNoteIndex: subchannel.last_note_index,
        token,
      });
      subchannelsByRecipient.set(recipient, current);
    }

    outgoingCursor = response.cursor ?? {};
  } while (!isCursorComplete(outgoingCursor));

  const outgoingChannels: PrivatePoolOutgoingChannel[] = [];
  for (const [recipient, channel] of createdChannels.entries()) {
    const subchannels = subchannelsByRecipient.get(recipient) ?? new Map<string, PrivatePoolSubchannel>();
    outgoingChannels.push({
      channelKey: channel.channelKey,
      precomputed: channel.precomputed,
      publicKey: channel.publicKey,
      recipient,
      subchannelCount: subchannels.size,
      subchannels,
    });
  }

  return {
    blockRef: incomingBlockRef ?? outgoingBlockRef,
    notes,
    outgoingChannels,
    totalOutgoingChannels,
  };
}

export function findOutgoingChannel(
  outgoingChannels: PrivatePoolOutgoingChannel[],
  recipientAddress: string,
): PrivatePoolOutgoingChannel | undefined {
  const target = BigInt(recipientAddress);
  return outgoingChannels.find((channel) => BigInt(channel.recipient) === target);
}

export function selectNotesForAmount(notes: PrivatePoolNote[], amount: bigint): {
  change: bigint;
  selected: PrivatePoolNote[];
  total: bigint;
} {
  const sortedNotes = [...notes].sort((left, right) => {
    if (left.amount === right.amount) {
      return left.index - right.index;
    }
    return left.amount > right.amount ? -1 : 1;
  });

  const selected: PrivatePoolNote[] = [];
  let total = 0n;

  for (const note of sortedNotes) {
    selected.push(note);
    total += note.amount;
    if (total >= amount) {
      return { change: total - amount, selected, total };
    }
  }

  throw new Error(
    `Insufficient private balance: ${formatStrk(total)} STRK available, ${formatStrk(amount)} requested.`,
  );
}
