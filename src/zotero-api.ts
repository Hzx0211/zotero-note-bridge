import {request as httpRequest} from 'node:http';

export interface ZoteroServerInfo {
  version: string;
  apiVersion: string;
  serverId: string;
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  note?: string;
  parentItem?: string;
  dateAdded?: string;
  dateModified?: string;
  [key: string]: unknown;
}

export interface ZoteroCollectionData {
  key: string;
  version: number;
  name: string;
  parentCollection?: string | false;
  [key: string]: unknown;
}

export interface ZoteroLibraryCache {
  schemaVersion: 1;
  serverId: string;
  libraryVersion: number;
  items: Record<string, ZoteroItemData>;
  collections: Record<string, ZoteroCollectionData>;
  itemVersions: Record<string, number>;
  collectionVersions: Record<string, number>;
  updatedAt: string;
}

export interface ZoteroLibraryPull {
  cache: ZoteroLibraryCache;
  full: boolean;
  changedItems: number;
  changedCollections: number;
  deletedItems: string[];
  deletedCollections: string[];
}

export class ZoteroApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = 'ZoteroApiError';
  }
}

export type SecretStorageLike = {
  getSecret(reference: string): Promise<string | null> | string | null;
  setSecret(reference: string, value: string): Promise<void> | void;
  deleteSecret?(reference: string): Promise<void> | void;
  removeSecret?(reference: string): Promise<void> | void;
};

export interface ZoteroLocalApiOptions {
  hostname?: string;
  port?: number;
  transport?: (request: ZoteroTransportRequest) => Promise<ZoteroTransportResponse>;
}

export function localApiSecretId(serverId: string): string {
  const normalizedServerId = serverId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const id = `zotero-note-bridge-${normalizedServerId}-local-api-key`;
  if (!normalizedServerId || id.length > 64 || !/^[a-z0-9-]+$/.test(id)) {
    throw new ZoteroApiError('无法为当前 Zotero Server ID 生成安全存储标识', 0);
  }
  return id;
}

export interface ZoteroTransportRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ZoteroTransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

function header(response: ZoteroTransportResponse, name: string): string {
  return response.headers[name.toLowerCase()] ?? '';
}

function unwrapItem(value: unknown): ZoteroItemData {
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const data = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
  const key = String(data.key ?? envelope.key ?? '');
  const version = Number(data.version ?? envelope.version ?? 0);
  const itemType = String(data.itemType ?? '');
  if (!/^[A-Za-z0-9]{8}$/.test(key) || !Number.isFinite(version) || !itemType) {
    throw new ZoteroApiError('Zotero 返回了无法识别的对象数据', 0, value);
  }
  return {...data, key, version, itemType} as ZoteroItemData;
}

function unwrapCollection(value: unknown): ZoteroCollectionData {
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const data = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
  const key = String(data.key ?? envelope.key ?? '');
  const version = Number(data.version ?? envelope.version ?? 0);
  const name = String(data.name ?? '');
  if (!/^[A-Za-z0-9]{8}$/.test(key) || !Number.isFinite(version) || !name) {
    throw new ZoteroApiError('Zotero 返回了无法识别的分类数据', 0, value);
  }
  return {...data, key, version, name} as ZoteroCollectionData;
}

function versionMap(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ZoteroApiError(`Zotero ${label}版本清单格式无效`, 0, value);
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const version = Number(raw);
    if (/^[A-Za-z0-9]{8}$/.test(key) && Number.isFinite(version)) result[key] = version;
  }
  return result;
}

export class ZoteroLocalApi {
  private serverId = '';
  private readonly hostname: string;
  private readonly port: number;
  private readonly transport?: ZoteroLocalApiOptions['transport'];

  constructor(private readonly secretStorage: SecretStorageLike, options: ZoteroLocalApiOptions = {}) {
    this.hostname = options.hostname ?? '127.0.0.1';
    this.port = options.port ?? 23119;
    this.transport = options.transport;
  }

  setExpectedServer(serverId: string): void {
    this.serverId = serverId;
  }

  private secretReference(serverId = this.serverId): string {
    return localApiSecretId(serverId);
  }

  private request(options: ZoteroTransportRequest): Promise<ZoteroTransportResponse> {
    if (this.transport) return this.transport(options);
    return new Promise((resolve, reject) => {
      const body = options.body ?? '';
      const request = httpRequest({
        hostname: this.hostname,
        port: this.port,
        path: `/api${options.path}`,
        method: options.method ?? 'GET',
        headers: {
          ...(body ? {'Content-Length': String(Buffer.byteLength(body))} : {}),
          ...(options.headers ?? {})
        }
      }, (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > 64 * 1024 * 1024) request.destroy(new Error('Zotero Local API 响应超过安全上限'));
        });
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          }
          let json: unknown = undefined;
          if (text.trim()) {
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
          }
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new ZoteroApiError(`Zotero Local API 请求失败（HTTP ${status}）`, status, json ?? text));
            return;
          }
          resolve({status, headers, text, json});
        });
      });
      request.on('error', (error) => reject(new ZoteroApiError(`无法连接本机 Zotero：${error.message}`, 0)));
      request.setTimeout(options.timeoutMs ?? 30000, () => request.destroy(new Error('Zotero Local API 请求超时')));
      if (body) request.write(body);
      request.end();
    });
  }

  private readHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Zotero-API-Version': '3',
      ...(this.serverId ? {'Zotero-Server-ID': this.serverId} : {}),
      ...extra
    };
  }

  private async paged<T>(
    endpoint: 'items' | 'collections',
    unwrap: (value: unknown) => T,
    since?: number
  ): Promise<{values: T[]; libraryVersion: number}> {
    const values: T[] = [];
    let start = 0;
    let libraryVersion = 0;
    while (true) {
      const params = new URLSearchParams({format: 'json', limit: '100', start: String(start)});
      if (since != null && since > 0) params.set('since', String(since));
      const response = await this.request({
        path: `/users/0/${endpoint}?${params.toString()}`,
        headers: this.readHeaders()
      });
      const page = Array.isArray(response.json) ? response.json : [];
      values.push(...page.map(unwrap));
      libraryVersion = Math.max(libraryVersion, Number(header(response, 'Last-Modified-Version')) || 0);
      const total = Number(header(response, 'Total-Results'));
      if (!page.length || !Number.isFinite(total) || values.length >= total) break;
      start += page.length;
    }
    return {values, libraryVersion};
  }

  private async versions(endpoint: 'items' | 'collections'): Promise<{versions: Record<string, number>; libraryVersion: number}> {
    const response = await this.request({
      path: `/users/0/${endpoint}?format=versions`,
      headers: this.readHeaders()
    });
    const libraryVersion = Number(header(response, 'Last-Modified-Version'));
    if (!Number.isFinite(libraryVersion)) throw new ZoteroApiError('无法读取 Zotero 文献库版本', response.status);
    return {versions: versionMap(response.json, endpoint), libraryVersion};
  }

  async getServerInfo(): Promise<ZoteroServerInfo> {
    const response = await this.request({path: '/'});
    const serverId = header(response, 'Zotero-Server-ID');
    const version = header(response, 'X-Zotero-Version');
    const apiVersion = header(response, 'Zotero-API-Version');
    if (!serverId || !version || apiVersion !== '3') {
      throw new ZoteroApiError('当前 Zotero 不支持所需的 Local API v3 写入协议', response.status);
    }
    return {serverId, version, apiVersion};
  }

  async clearAuthorization(): Promise<void> {
    if (!this.serverId) return;
    const reference = this.secretReference();
    const remover = this.secretStorage.deleteSecret ?? this.secretStorage.removeSecret;
    if (remover) await Promise.resolve(remover.call(this.secretStorage, reference));
    else await Promise.resolve(this.secretStorage.setSecret(reference, ''));
  }

  async authorize(): Promise<void> {
    if (!this.serverId) throw new ZoteroApiError('尚未确认 Zotero Server ID', 0);
    const response = await this.request({
      path: '/local/authorize',
      method: 'POST',
      timeoutMs: 5 * 60 * 1000,
      headers: {
        'Content-Type': 'application/json',
        'Zotero-API-Version': '3',
        'Zotero-Server-ID': this.serverId
      },
      body: JSON.stringify({appName: 'Obsidian Zotero Note Bridge'})
    });
    const value = response.json as {key?: unknown};
    const key = typeof value?.key === 'string' ? value.key : '';
    if (!key) throw new ZoteroApiError('Zotero 未返回写入授权密钥', response.status, value);
    await Promise.resolve(this.secretStorage.setSecret(this.secretReference(), key));
  }

  private async authorizedRequest(options: ZoteroTransportRequest, retry = true): Promise<ZoteroTransportResponse> {
    if (!this.serverId) throw new ZoteroApiError('尚未确认 Zotero Server ID', 0);
    let key = await Promise.resolve(this.secretStorage.getSecret(this.secretReference()));
    if (!key) {
      await this.authorize();
      key = await Promise.resolve(this.secretStorage.getSecret(this.secretReference()));
    }
    if (!key) throw new ZoteroApiError('无法从 Obsidian SecretStorage 取得授权密钥', 0);

    try {
      return await this.request({
        ...options,
        headers: {
          ...this.readHeaders(),
          ...(options.headers ?? {}),
          'Zotero-API-Key': key
        }
      });
    } catch (error) {
      if (error instanceof ZoteroApiError && error.status === 401 && retry) {
        await this.clearAuthorization();
        await this.authorize();
        return this.authorizedRequest(options, false);
      }
      throw error;
    }
  }

  async getItem(key: string): Promise<ZoteroItemData> {
    const response = await this.request({
      path: `/users/0/items/${encodeURIComponent(key)}`,
      headers: this.readHeaders()
    });
    return unwrapItem(response.json);
  }

  async getChildNotes(parentKey: string): Promise<ZoteroItemData[]> {
    const response = await this.request({
      path: `/users/0/items/${encodeURIComponent(parentKey)}/children`,
      headers: this.readHeaders()
    });
    const values = Array.isArray(response.json) ? response.json : [];
    return values.map(unwrapItem).filter((item) => item.itemType === 'note');
  }

  async pullLibrary(previous?: ZoteroLibraryCache | null): Promise<ZoteroLibraryPull> {
    if (!this.serverId) throw new ZoteroApiError('尚未确认 Zotero Server ID', 0);
    const [itemIndex, collectionIndex] = await Promise.all([
      this.versions('items'),
      this.versions('collections')
    ]);
    const full = !previous || previous.schemaVersion !== 1 || previous.serverId !== this.serverId;
    const deletedItems = full ? [] : Object.keys(previous.items).filter((key) => itemIndex.versions[key] == null);
    const deletedCollections = full ? [] : Object.keys(previous.collections).filter((key) => collectionIndex.versions[key] == null);
    const since = full ? undefined : previous.libraryVersion;
    const [itemPage, collectionPage] = await Promise.all([
      this.paged('items', unwrapItem, since),
      this.paged('collections', unwrapCollection, since)
    ]);
    const items: Record<string, ZoteroItemData> = full ? {} : {...previous.items};
    const collections: Record<string, ZoteroCollectionData> = full ? {} : {...previous.collections};
    for (const key of deletedItems) delete items[key];
    for (const key of deletedCollections) delete collections[key];
    for (const item of itemPage.values) items[item.key] = item;
    for (const collection of collectionPage.values) collections[collection.key] = collection;

    const missingItems = Object.keys(itemIndex.versions).filter((key) => !items[key] || items[key]?.version !== itemIndex.versions[key]);
    for (const key of missingItems) items[key] = await this.getItem(key);
    const missingCollections = Object.keys(collectionIndex.versions).filter((key) => !collections[key] || collections[key]?.version !== collectionIndex.versions[key]);
    for (const key of missingCollections) {
      const response = await this.request({
        path: `/users/0/collections/${encodeURIComponent(key)}`,
        headers: this.readHeaders()
      });
      collections[key] = unwrapCollection(response.json);
    }

    const libraryVersion = Math.max(
      itemIndex.libraryVersion,
      collectionIndex.libraryVersion,
      itemPage.libraryVersion,
      collectionPage.libraryVersion
    );
    return {
      full,
      changedItems: itemPage.values.length + missingItems.length,
      changedCollections: collectionPage.values.length + missingCollections.length,
      deletedItems,
      deletedCollections,
      cache: {
        schemaVersion: 1,
        serverId: this.serverId,
        libraryVersion,
        items,
        collections,
        itemVersions: itemIndex.versions,
        collectionVersions: collectionIndex.versions,
        updatedAt: new Date().toISOString()
      }
    };
  }

  async patchNote(key: string, noteHtml: string, expectedVersion: number): Promise<ZoteroItemData> {
    await this.authorizedRequest({
      path: `/users/0/items/${encodeURIComponent(key)}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': String(expectedVersion)
      },
      body: JSON.stringify({note: noteHtml})
    });
    return this.getItem(key);
  }

  private async getLibraryVersion(): Promise<number> {
    const response = await this.request({
      path: '/users/0/items?format=versions',
      headers: this.readHeaders()
    });
    const value = Number(header(response, 'Last-Modified-Version'));
    if (!Number.isFinite(value)) throw new ZoteroApiError('无法读取 Zotero 本地文献库版本', response.status);
    return value;
  }

  async createChildNote(parentKey: string, noteHtml: string, retry = true): Promise<ZoteroItemData> {
    const parent = await this.getItem(parentKey);
    if (parent.itemType === 'note' || parent.itemType === 'attachment' || parent.itemType === 'annotation') {
      throw new ZoteroApiError('当前文献卡的父对象不是可挂载子笔记的文献条目', 400);
    }
    const libraryVersion = await this.getLibraryVersion();
    // Cached official /items/new?itemType=note template. Zotero's local API does
    // not currently expose that schema endpoint, so only parentItem and note are added.
    const template = {
      itemType: 'note',
      note: noteHtml,
      tags: [],
      collections: [],
      relations: {},
      parentItem: parentKey
    };

    try {
      const response = await this.authorizedRequest({
        path: '/users/0/items',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Unmodified-Since-Version': String(libraryVersion)
        },
        body: JSON.stringify([template])
      });
      const value = response.json as Record<string, unknown>;
      const resultMap = (value.successful ?? value.success) as Record<string, unknown> | undefined;
      const saved = resultMap?.['0'];
      const key = typeof saved === 'string'
        ? saved
        : saved && typeof saved === 'object'
          ? String((saved as Record<string, unknown>).key ?? '')
          : '';
      if (!/^[A-Za-z0-9]{8}$/.test(key)) {
        throw new ZoteroApiError('Zotero 未返回新子笔记的 Note Key', response.status, value.failed);
      }
      return this.getItem(key);
    } catch (error) {
      if (error instanceof ZoteroApiError && error.status === 412 && retry) {
        return this.createChildNote(parentKey, noteHtml, false);
      }
      throw error;
    }
  }
}
