/**
 * Obsidian Local REST API Client
 * Requires the "Local REST API" community plugin in Obsidian
 */

import { logger } from '../modules/utils/logger.js';

const log = logger.child('ObsidianClient');

class ObsidianClient {
  constructor() {
    this.baseUrl = 'http://localhost:27123';
    this.apiKey = '';
  }

  async loadConfig() {
    const { settings } = await chrome.storage.local.get('settings');
    this.baseUrl = (settings?.obsidianUrl || 'http://localhost:27123').replace(/\/$/, '');
    this.apiKey = settings?.obsidianApiKey || '';
  }

  authHeaders() {
    return this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {};
  }

  encodePath(vaultPath) {
    return vaultPath.split('/').map(encodeURIComponent).join('/');
  }

  async testConnection() {
    try {
      await this.loadConfig();
      const response = await fetch(`${this.baseUrl}/`, {
        headers: this.authHeaders()
      });
      return { success: response.ok };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async saveNote(vaultPath, markdownContent) {
    await this.loadConfig();
    const response = await fetch(`${this.baseUrl}/vault/${this.encodePath(vaultPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown', ...this.authHeaders() },
      body: markdownContent
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Obsidian save failed (${response.status}): ${text}`);
    }
    return { success: true };
  }

  async saveImage(vaultPath, dataUrl) {
    await this.loadConfig();
    const blob = await (await fetch(dataUrl)).blob();
    const response = await fetch(`${this.baseUrl}/vault/${this.encodePath(vaultPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', ...this.authHeaders() },
      body: blob
    });
    if (!response.ok) throw new Error(`Image save failed (${response.status})`);
    return { success: true };
  }

  async deleteFile(vaultPath) {
    await this.loadConfig();
    const response = await fetch(`${this.baseUrl}/vault/${this.encodePath(vaultPath)}`, {
      method: 'DELETE',
      headers: this.authHeaders()
    });
    return { success: response.ok || response.status === 404 };
  }

  async fetchFile(vaultPath) {
    await this.loadConfig();
    const response = await fetch(`${this.baseUrl}/vault/${this.encodePath(vaultPath)}`, {
      headers: this.authHeaders()
    });
    if (!response.ok) return null;
    return await response.text();
  }

  /**
   * Fetch an image from the vault and return it as a base64 data URL.
   * Tries the provided path first; if it fails, tries fallback paths.
   * Returns null if the image cannot be retrieved.
   */
  async fetchImageAsDataUrl(vaultPath, fallbackPaths = []) {
    await this.loadConfig();
    const paths = [vaultPath, ...fallbackPaths];
    for (const p of paths) {
      try {
        const response = await fetch(`${this.baseUrl}/vault/${this.encodePath(p)}`, {
          headers: this.authHeaders()
        });
        if (!response.ok) continue;
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        if (dataUrl) return dataUrl;
      } catch (e) {
        log.warn('fetchImageAsDataUrl failed for path', p, e.message);
      }
    }
    return null;
  }

  async listFolder(folderPath) {
    await this.loadConfig();
    const pathPart = folderPath ? this.encodePath(folderPath) + '/' : '';
    const response = await fetch(`${this.baseUrl}/vault/${pathPart}`, {
      headers: this.authHeaders()
    });
    if (!response.ok) {
      if (response.status === 404) return { success: true, files: [] };
      throw new Error(`List failed (${response.status})`);
    }
    const result = await response.json();
    const files = (result.files || []).filter(f => typeof f === 'string' && f.endsWith('.md'));
    return { success: true, files };
  }

  async listVaultFolders() {
    await this.loadConfig();
    const response = await fetch(`${this.baseUrl}/vault/`, {
      headers: this.authHeaders()
    });
    if (!response.ok) {
      if (response.status === 404) return { success: true, folders: [] };
      throw new Error(`List vault failed (${response.status})`);
    }
    const result = await response.json();
    // Entries ending with '/' are directories
    const folders = (result.files || [])
      .filter(f => typeof f === 'string' && f.endsWith('/'))
      .map(f => f.replace(/\/$/, ''));
    return { success: true, folders };
  }

  buildMarkdown(title, items) {
    let md = '';
    for (const item of items) {
      if (item.type === 'text') {
        md += `${item.content.trim()}\n\n`;
      } else if (item.type === 'voice') {
        md += `> ${item.content.trim()}\n\n`;
      } else if (item.type === 'capture' && item.imageFilename) {
        md += `![[attachments/${item.imageFilename}]]\n\n`;
      }
    }
    return md;
  }
}

export const obsidianClient = new ObsidianClient();
export { ObsidianClient };
