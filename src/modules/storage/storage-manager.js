/**
 * Storage Manager - Abstraction layer over chrome.storage.local
 * Provides simple get/set/remove operations with error handling
 */

import { logger } from '../utils/logger.js';

class StorageManager {
  constructor() {
    this.log = logger.child('Storage');
  }

  /**
   * Get a single value from storage
   */
  async get(key) {
    try {
      const result = await chrome.storage.local.get(key);
      this.log.debug(`Get: ${key}`, result[key]);
      return result[key];
    } catch (error) {
      this.log.error(`Failed to get key: ${key}`, error);
      throw error;
    }
  }

  /**
   * Get multiple values from storage
   */
  async getMultiple(keys) {
    try {
      const result = await chrome.storage.local.get(keys);
      this.log.debug(`GetMultiple:`, result);
      return result;
    } catch (error) {
      this.log.error(`Failed to get keys: ${keys}`, error);
      throw error;
    }
  }

  /**
   * Get all data from storage
   */
  async getAll() {
    try {
      const result = await chrome.storage.local.get(null);
      this.log.debug('GetAll', Object.keys(result));
      return result;
    } catch (error) {
      this.log.error('Failed to get all data', error);
      throw error;
    }
  }

  /**
   * Set a single value in storage
   */
  async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      this.log.debug(`Set: ${key}`, value);
    } catch (error) {
      this.log.error(`Failed to set key: ${key}`, error);
      throw error;
    }
  }

  /**
   * Set multiple values in storage
   */
  async setMultiple(items) {
    try {
      await chrome.storage.local.set(items);
      this.log.debug('SetMultiple:', Object.keys(items));
    } catch (error) {
      this.log.error('Failed to set multiple items', error);
      throw error;
    }
  }

  /**
   * Remove a single key from storage
   */
  async remove(key) {
    try {
      await chrome.storage.local.remove(key);
      this.log.debug(`Removed: ${key}`);
    } catch (error) {
      this.log.error(`Failed to remove key: ${key}`, error);
      throw error;
    }
  }

  /**
   * Remove multiple keys from storage
   */
  async removeMultiple(keys) {
    try {
      await chrome.storage.local.remove(keys);
      this.log.debug(`Removed multiple:`, keys);
    } catch (error) {
      this.log.error('Failed to remove multiple keys', error);
      throw error;
    }
  }

  /**
   * Clear all data from storage
   */
  async clear() {
    try {
      await chrome.storage.local.clear();
      this.log.info('Storage cleared');
    } catch (error) {
      this.log.error('Failed to clear storage', error);
      throw error;
    }
  }

  /**
   * Get storage usage info
   */
  async getStorageInfo() {
    try {
      const bytesInUse = await chrome.storage.local.getBytesInUse(null);
      const quota = chrome.storage.local.QUOTA_BYTES || 10485760; // 10MB default
      const percentUsed = (bytesInUse / quota) * 100;

      const info = {
        bytesInUse,
        quota,
        percentUsed: percentUsed.toFixed(2),
        mbUsed: (bytesInUse / 1048576).toFixed(2),
        mbQuota: (quota / 1048576).toFixed(2)
      };

      this.log.debug('Storage info:', info);
      return info;
    } catch (error) {
      this.log.error('Failed to get storage info', error);
      throw error;
    }
  }

  /**
   * Update a nested property in an object
   * Example: updateNested('notes.note-123.metadata.syncStatus', 'synced')
   */
  async updateNested(path, value) {
    try {
      const keys = path.split('.');
      const rootKey = keys[0];

      const root = await this.get(rootKey);
      if (!root) {
        throw new Error(`Root key '${rootKey}' does not exist`);
      }

      let current = root;
      for (let i = 1; i < keys.length - 1; i++) {
        if (!current[keys[i]]) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = value;
      await this.set(rootKey, root);

      this.log.debug(`UpdateNested: ${path}`, value);
    } catch (error) {
      this.log.error(`Failed to update nested path: ${path}`, error);
      throw error;
    }
  }

  /**
   * Listen to storage changes
   */
  onChange(callback) {
    const listener = (changes, areaName) => {
      if (areaName === 'local') {
        this.log.debug('Storage changed:', Object.keys(changes));
        callback(changes);
      }
    };

    chrome.storage.onChanged.addListener(listener);

    // Return unsubscribe function
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }
}

// Export singleton instance
export const storage = new StorageManager();

// Export class for testing
export { StorageManager };
