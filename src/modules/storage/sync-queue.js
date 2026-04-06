/**
 * Sync Queue - Manages offline sync queue for notes
 */

import { storage } from './storage-manager.js';
import { logger } from '../utils/logger.js';

// Queue actions
export const QueueAction = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete'
};

class SyncQueue {
  constructor() {
    this.log = logger.child('SyncQueue');
  }

  /**
   * Get the entire sync queue
   */
  async getQueue() {
    try {
      const queue = await storage.get('syncQueue');
      return queue || [];
    } catch (error) {
      this.log.error('Failed to get sync queue', error);
      throw error;
    }
  }

  /**
   * Add an item to the sync queue
   */
  async addToQueue(noteId, action) {
    try {
      const queue = await this.getQueue();

      // Check if note is already in queue
      const existingIndex = queue.findIndex(item => item.noteId === noteId);

      if (existingIndex !== -1) {
        // Update existing queue item
        queue[existingIndex] = {
          ...queue[existingIndex],
          action,
          retryCount: queue[existingIndex].retryCount || 0,
          lastAttempt: null,
          error: null
        };
        this.log.debug(`Updated queue item for note: ${noteId}`);
      } else {
        // Add new queue item
        queue.push({
          noteId,
          action,
          retryCount: 0,
          lastAttempt: null,
          error: null
        });
        this.log.debug(`Added to queue: ${noteId} (${action})`);
      }

      await storage.set('syncQueue', queue);
      return queue;
    } catch (error) {
      this.log.error('Failed to add to queue', error);
      throw error;
    }
  }

  /**
   * Remove an item from the sync queue
   */
  async removeFromQueue(noteId) {
    try {
      const queue = await this.getQueue();
      const filteredQueue = queue.filter(item => item.noteId !== noteId);

      await storage.set('syncQueue', filteredQueue);
      this.log.debug(`Removed from queue: ${noteId}`);

      return filteredQueue;
    } catch (error) {
      this.log.error('Failed to remove from queue', error);
      throw error;
    }
  }

  /**
   * Update a queue item (for retry tracking)
   */
  async updateQueueItem(noteId, updates) {
    try {
      const queue = await this.getQueue();
      const itemIndex = queue.findIndex(item => item.noteId === noteId);

      if (itemIndex === -1) {
        throw new Error(`Queue item not found: ${noteId}`);
      }

      queue[itemIndex] = {
        ...queue[itemIndex],
        ...updates
      };

      await storage.set('syncQueue', queue);
      this.log.debug(`Updated queue item: ${noteId}`, updates);

      return queue[itemIndex];
    } catch (error) {
      this.log.error('Failed to update queue item', error);
      throw error;
    }
  }

  /**
   * Get queue items ready for retry
   * Returns items that haven't been attempted recently
   */
  async getItemsReadyForRetry(minDelayMs = 5000) {
    try {
      const queue = await this.getQueue();
      const now = Date.now();

      return queue.filter(item => {
        // Never attempted
        if (!item.lastAttempt) {
          return true;
        }

        // Exponential backoff based on retry count
        const backoffDelays = [5000, 15000, 60000, 300000]; // 5s, 15s, 1m, 5m
        const delay = backoffDelays[Math.min(item.retryCount, backoffDelays.length - 1)];

        return (now - item.lastAttempt) >= delay;
      });
    } catch (error) {
      this.log.error('Failed to get items ready for retry', error);
      throw error;
    }
  }

  /**
   * Mark a sync attempt for an item
   */
  async markAttempt(noteId, success = false, error = null) {
    try {
      const queue = await this.getQueue();
      const itemIndex = queue.findIndex(item => item.noteId === noteId);

      if (itemIndex === -1) {
        throw new Error(`Queue item not found: ${noteId}`);
      }

      if (success) {
        // Remove from queue on success
        await this.removeFromQueue(noteId);
      } else {
        // Update retry info on failure
        queue[itemIndex].retryCount += 1;
        queue[itemIndex].lastAttempt = Date.now();
        queue[itemIndex].error = error;

        await storage.set('syncQueue', queue);
        this.log.debug(`Marked attempt for ${noteId}: retry ${queue[itemIndex].retryCount}`);
      }
    } catch (error) {
      this.log.error('Failed to mark attempt', error);
      throw error;
    }
  }

  /**
   * Get queue size
   */
  async getQueueSize() {
    try {
      const queue = await this.getQueue();
      return queue.length;
    } catch (error) {
      this.log.error('Failed to get queue size', error);
      throw error;
    }
  }

  /**
   * Clear the entire queue
   */
  async clearQueue() {
    try {
      await storage.set('syncQueue', []);
      this.log.warn('Cleared sync queue');
      return true;
    } catch (error) {
      this.log.error('Failed to clear queue', error);
      throw error;
    }
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    try {
      const queue = await this.getQueue();

      const stats = {
        total: queue.length,
        create: queue.filter(item => item.action === QueueAction.CREATE).length,
        update: queue.filter(item => item.action === QueueAction.UPDATE).length,
        delete: queue.filter(item => item.action === QueueAction.DELETE).length,
        withErrors: queue.filter(item => item.error !== null).length,
        highRetryCount: queue.filter(item => item.retryCount >= 3).length
      };

      this.log.debug('Queue stats:', stats);
      return stats;
    } catch (error) {
      this.log.error('Failed to get queue stats', error);
      throw error;
    }
  }
}

// Export singleton instance
export const syncQueue = new SyncQueue();

// Export class for testing
export { SyncQueue };
