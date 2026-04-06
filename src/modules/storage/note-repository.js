/**
 * Note Repository - CRUD operations for notes
 * Handles the data model and persistence logic
 */

import { storage } from './storage-manager.js';
import { logger } from '../utils/logger.js';

// Note types
export const NoteType = {
  CAPTURE: 'capture',
  VOICE: 'voice',
  MANUAL: 'manual',
  MIXED: 'mixed'
};

// Sync status
export const SyncStatus = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  ERROR: 'error'
};

class NoteRepository {
  constructor() {
    this.log = logger.child('NoteRepository');
  }

  /**
   * Generate a unique ID for a note
   */
  generateId() {
    return `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create a new note
   */
  async createNote(noteData) {
    try {
      const id = this.generateId();
      const now = Date.now();

      const note = {
        id,
        type: noteData.type || NoteType.MANUAL,
        content: {
          text: noteData.text || '',
          ocrText: noteData.ocrText || '',
          imageDataUrl: noteData.imageDataUrl || null,
          videoUrl: noteData.videoUrl || '',
          timestamp: noteData.videoTimestamp || '0:00'
        },
        metadata: {
          pageTitle: noteData.pageTitle || '',
          pageUrl: noteData.pageUrl || '',
          createdAt: now,
          updatedAt: now,
          syncStatus: SyncStatus.PENDING,
          googleDocPosition: null,
          syncedToDocId: null  // Track which document this note was synced to
        }
      };

      // Get existing notes
      const notes = await this.getAllNotes();
      notes[id] = note;

      // Save to storage
      await storage.set('notes', notes);

      this.log.info(`Created note: ${id}`);
      return note;
    } catch (error) {
      this.log.error('Failed to create note', error);
      throw error;
    }
  }

  /**
   * Get a single note by ID
   */
  async getNote(id) {
    try {
      const notes = await this.getAllNotes();
      return notes[id] || null;
    } catch (error) {
      this.log.error(`Failed to get note: ${id}`, error);
      throw error;
    }
  }

  /**
   * Get all notes
   */
  async getAllNotes() {
    try {
      const notes = await storage.get('notes');
      return notes || {};
    } catch (error) {
      this.log.error('Failed to get all notes', error);
      throw error;
    }
  }

  /**
   * Get notes as an array (sorted by creation date, newest first)
   */
  async getNotesArray() {
    try {
      const notesObj = await this.getAllNotes();
      const notesArray = Object.values(notesObj);

      // Sort by createdAt descending (newest first)
      notesArray.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);

      return notesArray;
    } catch (error) {
      this.log.error('Failed to get notes array', error);
      throw error;
    }
  }

  /**
   * Update an existing note
   */
  async updateNote(id, updates) {
    try {
      const notes = await this.getAllNotes();
      const note = notes[id];

      if (!note) {
        throw new Error(`Note not found: ${id}`);
      }

      // Deep merge updates
      if (updates.content) {
        note.content = { ...note.content, ...updates.content };
      }

      if (updates.metadata) {
        note.metadata = { ...note.metadata, ...updates.metadata };
      }

      if (updates.type) {
        note.type = updates.type;
      }

      // Update timestamp
      note.metadata.updatedAt = Date.now();

      // Mark as pending sync if not a sync-related update
      if (!updates.metadata?.syncStatus) {
        note.metadata.syncStatus = SyncStatus.PENDING;
      }

      // Save
      notes[id] = note;
      await storage.set('notes', notes);

      this.log.info(`Updated note: ${id}`);
      return note;
    } catch (error) {
      this.log.error(`Failed to update note: ${id}`, error);
      throw error;
    }
  }

  /**
   * Delete a note
   */
  async deleteNote(id) {
    try {
      const notes = await this.getAllNotes();

      if (!notes[id]) {
        throw new Error(`Note not found: ${id}`);
      }

      delete notes[id];
      await storage.set('notes', notes);

      this.log.info(`Deleted note: ${id}`);
      return true;
    } catch (error) {
      this.log.error(`Failed to delete note: ${id}`, error);
      throw error;
    }
  }

  /**
   * Get notes by sync status
   */
  async getNotesByStatus(status) {
    try {
      const notes = await this.getNotesArray();
      return notes.filter(note => note.metadata.syncStatus === status);
    } catch (error) {
      this.log.error(`Failed to get notes by status: ${status}`, error);
      throw error;
    }
  }

  /**
   * Get notes for a specific video URL
   */
  async getNotesByVideoUrl(videoUrl) {
    try {
      const notes = await this.getNotesArray();
      return notes.filter(note => note.content.videoUrl === videoUrl);
    } catch (error) {
      this.log.error('Failed to get notes by video URL', error);
      throw error;
    }
  }

  /**
   * Update sync status for a note
   */
  async updateSyncStatus(id, status, googleDocPosition = null) {
    try {
      const updates = {
        metadata: {
          syncStatus: status
        }
      };

      if (googleDocPosition !== null) {
        updates.metadata.googleDocPosition = googleDocPosition;
      }

      return await this.updateNote(id, updates);
    } catch (error) {
      this.log.error(`Failed to update sync status for note: ${id}`, error);
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  async getStats() {
    try {
      const notes = await this.getNotesArray();
      const storageInfo = await storage.getStorageInfo();

      const stats = {
        totalNotes: notes.length,
        pending: notes.filter(n => n.metadata.syncStatus === SyncStatus.PENDING).length,
        synced: notes.filter(n => n.metadata.syncStatus === SyncStatus.SYNCED).length,
        errors: notes.filter(n => n.metadata.syncStatus === SyncStatus.ERROR).length,
        withImages: notes.filter(n => n.content.imageDataUrl).length,
        withOCR: notes.filter(n => n.content.ocrText).length,
        storage: storageInfo
      };

      this.log.debug('Note stats:', stats);
      return stats;
    } catch (error) {
      this.log.error('Failed to get stats', error);
      throw error;
    }
  }

  /**
   * Clear all notes (for testing/reset)
   */
  async clearAll() {
    try {
      await storage.set('notes', {});
      this.log.warn('Cleared all notes');
      return true;
    } catch (error) {
      this.log.error('Failed to clear notes', error);
      throw error;
    }
  }
}

// Export singleton instance
export const noteRepository = new NoteRepository();

// Export class for testing
export { NoteRepository };
