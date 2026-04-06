/**
 * Sync Manager - Processes sync queue and syncs notes to Google Docs
 * Handles online/offline detection, retry logic, and batch processing
 */

import { logger } from '../modules/utils/logger.js';
import { noteRepository, SyncStatus } from '../modules/storage/note-repository.js';
import { syncQueue, QueueAction } from '../modules/storage/sync-queue.js';
import { obsidianClient } from './obsidian-client.js';

const log = logger.child('SyncManager');

// Retry configuration
const MAX_RETRY_COUNT = 5;
const BASE_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 300000; // 5 minutes

class SyncManager {
  constructor() {
    this.isSyncing = false;
    this.targetFolderId = null;
    this.isOnline = navigator.onLine;

    // Listen to online/offline events
    this.setupNetworkListeners();
  }

  /**
   * Initialize sync manager and load settings
   */
  async init() {
    try {
      log.info('Initializing Sync Manager');

      // Load target document ID from settings
      const { settings } = await chrome.storage.local.get('settings');
      this.targetFolderId = settings?.targetFolderId || settings?.targetDocId || null;

      log.info('Sync Manager initialized', {
        targetFolderId: this.targetFolderId,
        isOnline: this.isOnline
      });

      // Process queue if online and authenticated
      if (this.isOnline) {
        await this.processQueue();
      }

    } catch (error) {
      log.error('Failed to initialize Sync Manager', error);
    }
  }

  /**
   * Setup network status listeners
   */
  setupNetworkListeners() {
    // Note: These listeners work in service worker context
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        log.info('Network status: Online');
        this.isOnline = true;
        this.processQueue();
      });

      window.addEventListener('offline', () => {
        log.info('Network status: Offline');
        this.isOnline = false;
      });
    }
  }

  /**
   * Set target Google Doc ID for syncing
   */
  async setTargetDocument(folderId, folderName = '') {
    try {
      this.targetFolderId = folderId;

      // Save to settings
      const { settings } = await chrome.storage.local.get('settings');
      const updatedSettings = { ...settings, targetFolderId: folderId, targetFolderName: folderName, targetDocId: folderId };
      await chrome.storage.local.set({ settings: updatedSettings });

      log.info('Target document set', { folderId });

      return { success: true };
    } catch (error) {
      log.error('Failed to set target document', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Set vault folder path as target (Obsidian folders are just paths)
   */
  async createAndSetTargetDocument(title) {
    try {
      log.info('Setting vault folder path', { title });

      await this.setTargetDocument(title, title);

      log.info('Vault folder path set', { title });

      return {
        success: true,
        documentId: title
      };

    } catch (error) {
      log.error('Failed to set vault folder', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process the sync queue
   */
  async processQueue() {
    // Prevent concurrent processing
    if (this.isSyncing) {
      log.debug('Sync already in progress, skipping');
      return { success: false, reason: 'already_syncing' };
    }

    // Check if online
    if (!this.isOnline) {
      log.debug('Device offline, skipping sync');
      return { success: false, reason: 'offline' };
    }

    // Check if target document is set
    if (!this.targetFolderId) {
      log.debug('No target folder set, skipping sync');
      return { success: false, reason: 'no_target_folder' };
    }

    try {
      this.isSyncing = true;
      log.info('Starting sync queue processing');

      // Pull remote changes from Obsidian first (before pushing local changes)
      const pullResult = await this.pullFromObsidian();

      // Get pending queue items
      const queue = await syncQueue.getQueue();
      const pendingItems = queue.filter(item => {
        // Skip items that have exceeded max retry count
        if (item.retryCount >= MAX_RETRY_COUNT) {
          log.warn('Item exceeded max retries', { noteId: item.noteId });
          return false;
        }

        // Check if enough time has passed since last attempt
        if (item.lastAttempt) {
          const retryDelay = this.calculateRetryDelay(item.retryCount);
          const nextAttemptTime = item.lastAttempt + retryDelay;

          if (Date.now() < nextAttemptTime) {
            log.debug('Item not ready for retry', {
              noteId: item.noteId,
              nextAttemptTime
            });
            return false;
          }
        }

        return true;
      });

      log.info(`Processing ${pendingItems.length} pending items`);

      // Process each item
      let successCount = 0;
      let errorCount = 0;

      for (const item of pendingItems) {
        try {
          const result = await this.processSyncItem(item);

          if (result.success) {
            successCount++;
          } else {
            errorCount++;
          }

        } catch (error) {
          log.error('Failed to process sync item', error, { noteId: item.noteId });
          errorCount++;
        }
      }

      log.info('Sync queue processing complete', {
        successCount,
        errorCount,
        total: pendingItems.length
      });

      return {
        success: true,
        processed: pendingItems.length,
        successCount,
        errorCount,
        imported: pullResult?.imported || 0,
        updated: pullResult?.updated || 0
      };

    } catch (error) {
      log.error('Failed to process sync queue', error);
      return { success: false, error: error.message };

    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Process a single sync queue item
   */
  async processSyncItem(item) {
    const { noteId, action, retryCount } = item;

    log.info('Processing sync item', { noteId, action, retryCount });

    try {
      // Get note from storage
      const note = await noteRepository.getNote(noteId);

      if (!note) {
        // Note deleted locally, remove from queue
        await syncQueue.removeFromQueue(noteId);
        log.info('Note not found, removed from queue', { noteId });
        return { success: true, action: 'removed' };
      }

      // Update note status to SYNCING
      await noteRepository.updateNote(noteId, {
        metadata: { syncStatus: SyncStatus.SYNCING }
      });

      let result;

      switch (action) {
        case QueueAction.CREATE:
        case QueueAction.UPDATE:
          // Sync note to Google Doc
          result = await this.syncNoteToDoc(note);
          break;

        case QueueAction.DELETE:
          // Delete note from Google Doc (not implemented yet)
          result = await this.deleteNoteFromDoc(note);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      if (result.success) {
        // Store the individual doc ID (workspace notes create their own file)
        const syncedDocId = result.documentId || this.targetFolderId;
        const updateObj = {
          metadata: {
            syncStatus: SyncStatus.SYNCED,
            lastSyncedAt: Date.now(),
            syncedToDocId: syncedDocId,
            googleDocId: result.documentId || null
          }
        };
        // Persist imageFilenames back into the workspace so captures can be
        // reliably re-matched by filename rather than array index on future opens.
        if (result.updatedWorkspace) {
          updateObj.content = { text: result.updatedWorkspace };
        }
        await noteRepository.updateNote(noteId, updateObj);

        // Remove from queue
        await syncQueue.removeFromQueue(noteId);

        log.info('Sync item processed successfully', { noteId, action, targetFolderId: this.targetFolderId });

        return { success: true };

      } else {
        throw new Error(result.error || 'Sync failed');
      }

    } catch (error) {
      log.error('Failed to process sync item', error, { noteId, action });

      // Update retry count and last attempt time
      await syncQueue.updateItem(noteId, {
        retryCount: retryCount + 1,
        lastAttempt: Date.now(),
        lastError: error.message
      });

      // Update note status to ERROR
      await noteRepository.updateNote(noteId, {
        metadata: {
          syncStatus: SyncStatus.ERROR,
          syncError: error.message
        }
      });

      // Schedule retry if not exceeded max retries
      if (retryCount + 1 < MAX_RETRY_COUNT) {
        const retryDelay = this.calculateRetryDelay(retryCount + 1);
        await this.scheduleRetry(retryDelay);

        log.info('Sync retry scheduled', {
          noteId,
          retryCount: retryCount + 1,
          retryDelay
        });
      } else {
        log.warn('Max retries exceeded, giving up', { noteId });
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Sync a note to Google Doc
   */
  async syncNoteToDoc(note) {
    try {
      log.info('Syncing note to Obsidian', { noteId: note.id });

      const folderPath = this.targetFolderId || '';

      // Parse workspace data
      let workspaceData = null;
      try {
        const parsed = JSON.parse(note.content.text);
        if (parsed && parsed.__workspace) workspaceData = parsed;
      } catch (e) {}

      const title = workspaceData?.title || note.metadata.pageTitle || 'Untitled';
      const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'Untitled';

      // Annotate capture items with stable image filenames.
      // Reuse stored imageFilename if present so the mapping never shifts after a pull.
      const items = (workspaceData?.items || []).map((item, i) => {
        if (item.type === 'capture') {
          return { ...item, imageFilename: item.imageFilename || `${note.id}-${i}.jpg` };
        }
        return item;
      });

      // Save images to attachments subfolder
      for (const item of items) {
        if (item.type === 'capture' && item.imageDataUrl && item.imageFilename) {
          const imagePath = folderPath
            ? `${folderPath}/attachments/${item.imageFilename}`
            : `attachments/${item.imageFilename}`;
          try {
            await obsidianClient.saveImage(imagePath, item.imageDataUrl);
          } catch (e) {
            log.warn('Failed to save image to Obsidian:', e.message);
          }
        }
      }

      // Build and save markdown
      const markdown = obsidianClient.buildMarkdown(title, items);
      const notePath = folderPath ? `${folderPath}/${safeTitle}.md` : `${safeTitle}.md`;

      // If the note was previously synced to a different vault path (e.g. the title
      // changed), delete the old file before writing the new one.  Without this, the
      // stale file would be re-imported by pullFromObsidian as a fresh note every sync.
      if (note.metadata.googleDocId && note.metadata.googleDocId !== notePath) {
        try {
          await obsidianClient.deleteFile(note.metadata.googleDocId);
          log.info('Deleted stale note file from Obsidian:', note.metadata.googleDocId);
        } catch (e) {
          log.warn('Could not delete old note file (non-fatal):', e.message);
        }
      }

      await obsidianClient.saveNote(notePath, markdown);

      // Return updated workspace JSON (with imageFilenames stored) so processSyncItem
      // can persist it — this enables reliable capture matching on future pulls/opens.
      let updatedWorkspace = null;
      if (workspaceData && items.some(i => i.type === 'capture')) {
        updatedWorkspace = JSON.stringify({ ...workspaceData, items });
      }

      log.info('Note synced to Obsidian:', notePath);
      return { success: true, documentId: notePath, noteId: note.id, updatedWorkspace };

    } catch (error) {
      log.error('Failed to sync note to Obsidian', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a note and its attachments from Obsidian
   */
  async deleteNoteFromDoc(note) {
    const folderPath = this.targetFolderId || '';

    // Delete the .md file
    if (note.metadata.googleDocId) {
      try {
        await obsidianClient.deleteFile(note.metadata.googleDocId);
        log.info('Deleted note from Obsidian:', note.metadata.googleDocId);
      } catch (error) {
        log.warn('Failed to delete note file (non-fatal):', error.message);
      }
    }

    // Delete attachment images
    const imagePaths = this.getAttachmentPaths(note, folderPath);
    for (const imagePath of imagePaths) {
      try {
        await obsidianClient.deleteFile(imagePath);
        log.info('Deleted attachment:', imagePath);
      } catch (error) {
        log.warn('Failed to delete attachment (non-fatal):', error.message);
      }
    }

    return { success: true };
  }

  /**
   * Get Obsidian vault paths for all images attached to a note
   */
  getAttachmentPaths(note, folderPath) {
    const paths = [];
    try {
      const parsed = JSON.parse(note.content.text);
      if (parsed?.__workspace) {
        (parsed.items || []).forEach((item, i) => {
          if (item.type === 'capture') {
            const filename = `${note.id}-${i}.jpg`;
            paths.push(folderPath ? `${folderPath}/attachments/${filename}` : `attachments/${filename}`);
          }
        });
      }
    } catch (e) {}
    return paths;
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  calculateRetryDelay(retryCount) {
    const delay = Math.min(
      BASE_RETRY_DELAY * Math.pow(2, retryCount),
      MAX_RETRY_DELAY
    );

    // Add jitter (±25%)
    const jitter = delay * 0.25 * (Math.random() - 0.5);

    return Math.floor(delay + jitter);
  }

  /**
   * Schedule a retry using chrome.alarms
   */
  async scheduleRetry(delayMs) {
    const delayMinutes = Math.max(delayMs / 60000, 0.1); // Minimum 0.1 minutes

    try {
      await chrome.alarms.create('sync-retry', {
        delayInMinutes: delayMinutes
      });

      log.debug('Retry scheduled', { delayMinutes });

    } catch (error) {
      log.error('Failed to schedule retry', error);
    }
  }

  /**
   * Pull all notes from Obsidian into local storage.
   * - New Obsidian files not in local storage → imported as new notes (marked synced).
   * - Existing local notes whose Obsidian file changed → updated, BUT only if local
   *   status is SYNCED (i.e. no unsaved local edits pending).
   */
  async pullFromObsidian(force = false) {
    const folderPath = this.targetFolderId;
    if (!folderPath) return { success: false, reason: 'no_target_folder' };

    log.info('Pulling notes from Obsidian folder:', folderPath);

    try {
      const listResult = await obsidianClient.listFolder(folderPath);
      if (!listResult.success) return { success: false, error: 'Could not list Obsidian folder' };

      const mdFiles = listResult.files; // e.g. ['My Note.md', 'Other.md']
      if (mdFiles.length === 0) return { success: true, imported: 0, updated: 0 };

      // Build map: googleDocId (vault path) → local note
      const allNotes = await noteRepository.getNotesArray();
      const byDocId = {};
      for (const note of allNotes) {
        if (note.metadata.googleDocId) byDocId[note.metadata.googleDocId] = note;
      }

      let imported = 0;
      let updated = 0;

      for (const filename of mdFiles) {
        const vaultPath = `${folderPath}/${filename}`;

        let markdown;
        try {
          markdown = await obsidianClient.fetchFile(vaultPath);
          if (!markdown) continue;
        } catch (e) {
          log.warn('Could not fetch', vaultPath, e.message);
          continue;
        }

        const { title, body, blocks } = this._parseMarkdown(markdown, filename.replace(/\.md$/i, ''));
        const existingNote = byDocId[vaultPath];

        if (existingNote) {
          // With force=true (sync button), Obsidian is master — overwrite even pending local edits.
          // Without force (background pull), skip notes with pending local changes.
          if (force || existingNote.metadata.syncStatus !== SyncStatus.PENDING) {
            // Parse existing local workspace to extract current title and text
            let existingWorkspace = null;
            try {
              const parsed = JSON.parse(existingNote.content.text);
              if (parsed?.__workspace) existingWorkspace = parsed;
            } catch (e) {}

            const existingTitle = existingWorkspace?.title || existingNote.metadata.pageTitle || '';

            // Build a comparable text body from the local workspace (text/voice items only)
            const existingTextBody = (existingWorkspace?.items || [])
              .filter(i => i.type === 'text' || i.type === 'voice')
              .map(i => i.type === 'voice' ? `> ${i.content}` : i.content)
              .join('\n\n')
              .trim();

            // Preserve all capture items from local workspace (they carry imageDataUrl
            // and imageFilename which cannot be reconstructed from the markdown alone).
            // Use the global item index as fallback filename for notes pushed before
            // the imageFilename write-back fix was introduced.
            const captureItems = [];
            const captureByFilename = {};
            (existingWorkspace?.items || []).forEach((item, globalIdx) => {
              if (item.type === 'capture') {
                captureItems.push(item);
                const fn = item.imageFilename || `${existingNote.id}-${globalIdx}.jpg`;
                captureByFilename[fn] = item;
              }
            });

            // Check if image order changed in Obsidian vs local
            const obsidianImageOrder = blocks.filter(b => b.type === 'image').map(b => b.filename).join('\0');
            const localImageOrder = captureItems.map((item, ci) => {
              const globalIdx = (existingWorkspace?.items || []).indexOf(item);
              return item.imageFilename || `${existingNote.id}-${globalIdx}.jpg`;
            }).join('\0');

            // Only write if Obsidian content actually changed (title, text, or image order)
            if (existingTitle !== title || existingTextBody !== body || obsidianImageOrder !== localImageOrder) {
              // Reconstruct items following Obsidian's block order.
              // For image blocks not in the local cache (manually inserted in Obsidian),
              // attempt to fetch the image data from the vault and create a new capture item.
              const newItems = [];
              let textIdx = 0;
              for (const block of blocks) {
                if (block.type === 'text') {
                  newItems.push({ id: `item-pull-${existingNote.id}-t${textIdx++}`, type: 'text', content: block.content, timestamp: Date.now() });
                } else if (block.type === 'image') {
                  const captureItem = captureByFilename[block.filename];
                  if (captureItem) {
                    newItems.push(captureItem);
                  } else {
                    // Unknown image — try to fetch from vault
                    const imageDataUrl = await this._fetchVaultImage(folderPath, block.filename);
                    if (imageDataUrl) {
                      newItems.push({
                        id: `item-pull-img-${block.filename}`,
                        type: 'capture',
                        imageDataUrl,
                        imageFilename: block.filename,
                        pageTitle: block.filename,
                        timestamp: Date.now()
                      });
                    }
                  }
                }
              }
              // Append any captures whose filenames weren't matched in the markdown
              const usedFilenames = new Set(blocks.filter(b => b.type === 'image').map(b => b.filename));
              for (const item of captureItems) {
                const fn = item.imageFilename || '';
                if (!fn || !usedFilenames.has(fn)) {
                  newItems.push(item);
                }
              }

              const newWorkspace = JSON.stringify({ __workspace: true, title, items: newItems });
              await noteRepository.updateNote(existingNote.id, {
                content: {
                  text: newWorkspace,
                  // Keep the existing top-level imageDataUrl (used for the list preview)
                  imageDataUrl: existingNote.content.imageDataUrl
                },
                metadata: { pageTitle: title, syncStatus: SyncStatus.SYNCED, lastSyncedAt: Date.now() }
              });
              // If we force-overwrote a pending note, remove it from the sync queue
              // so the old local version doesn't get pushed back to Obsidian.
              if (force) {
                await syncQueue.removeFromQueue(existingNote.id);
              }
              updated++;
            }
          }
        } else {
          // New note from Obsidian — import it.
          // Fetch any image attachments from the vault so they display as thumbnails.
          const newItems = [];
          let importTextIdx = 0;
          for (const block of blocks) {
            if (block.type === 'text') {
              newItems.push({ id: `item-import-${Date.now()}-t${importTextIdx++}`, type: 'text', content: block.content, timestamp: Date.now() });
            } else if (block.type === 'image') {
              const imageDataUrl = await this._fetchVaultImage(folderPath, block.filename);
              if (imageDataUrl) {
                newItems.push({
                  id: `item-import-img-${block.filename}`,
                  type: 'capture',
                  imageDataUrl,
                  imageFilename: block.filename,
                  pageTitle: block.filename,
                  timestamp: Date.now()
                });
              }
            }
          }
          // Fallback: if blocks produced nothing but there's a text body, use it
          if (newItems.length === 0 && body) {
            newItems.push({ id: `item-import-${Date.now()}`, type: 'text', content: body, timestamp: Date.now() });
          }
          const newWorkspace = JSON.stringify({ __workspace: true, title, items: newItems });
          const note = await noteRepository.createNote({
            type: 'manual',
            text: newWorkspace,
            pageTitle: title,
            pageUrl: '',
            ocrText: '',
            imageDataUrl: null,
            videoUrl: '',
            videoTimestamp: '0:00'
          });
          // Mark synced immediately so it doesn't get pushed back
          await noteRepository.updateNote(note.id, {
            metadata: { syncStatus: SyncStatus.SYNCED, googleDocId: vaultPath, lastSyncedAt: Date.now() }
          });
          imported++;
        }
      }

      log.info('Pull complete', { imported, updated, total: mdFiles.length });
      return { success: true, imported, updated };

    } catch (error) {
      log.error('Pull from Obsidian failed', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetch an image from the Obsidian vault and return it as a data URL.
   * Tries {folderPath}/attachments/{filename} first, then {folderPath}/{filename},
   * then the bare filename at vault root as a last resort.
   */
  async _fetchVaultImage(folderPath, filename) {
    const candidates = [];
    if (folderPath) {
      candidates.push(`${folderPath}/attachments/${filename}`);
      candidates.push(`${folderPath}/${filename}`);
    }
    candidates.push(`attachments/${filename}`);
    candidates.push(filename);
    try {
      return await obsidianClient.fetchImageAsDataUrl(candidates[0], candidates.slice(1));
    } catch (e) {
      log.warn('_fetchVaultImage failed', filename, e.message);
      return null;
    }
  }

  /**
   * Parse title and body from an Obsidian markdown file.
   * Handles:
   *  - Notes created by this extension (# Title + *date* + --- separator)
   *  - Plain Obsidian notes with just a # heading
   *  - Notes with YAML frontmatter (title: field)
   *  - Notes with no heading at all (fallbackTitle = filename without .md)
   */
  _parseMarkdown(markdown, fallbackTitle = 'Untitled') {
    let title = fallbackTitle;
    let body = markdown;

    // 1. Strip YAML frontmatter and try to extract title from it
    const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n*([\s\S]*)$/);
    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      body = frontmatterMatch[2].trim();
      const titleLine = fm.match(/^title:\s*(.+)$/m);
      if (titleLine) {
        title = titleLine[1].trim().replace(/^["']|["']$/g, '');
      }
    }

    // 2. Extract # heading title (overrides frontmatter title if present)
    const headingMatch = body.match(/^# (.+)/m);
    if (headingMatch) {
      title = headingMatch[1].trim();
      // Remove the heading line from body
      body = body.replace(/^# [^\n]*\n*/m, '').trim();
    }

    // 3. Strip legacy metadata added by older versions of this extension:
    //    "*date string*\n\n---\n\n"  (timestamp + separator)
    //    "---\n\n"                   (separator only, after timestamp was removed)
    const metaMatch = body.match(/^\*[^\n]*\*\n\n---\n\n([\s\S]*)$/);
    if (metaMatch) {
      body = metaMatch[1].trim();
    } else {
      body = body.replace(/^---\n\n/, '').trim();
    }

    // 4. Parse into ordered blocks (text segments interleaved with image embeds).
    // Match ![[path/to/image.ext]] or ![[image.ext]] — extract only the basename.
    const imagePattern = /!\[\[(?:[^\]]*\/)?([^/\]]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg))\]\]/gi;
    const blocks = [];
    let lastIndex = 0;
    let imgMatch;
    while ((imgMatch = imagePattern.exec(body)) !== null) {
      const textBefore = body.slice(lastIndex, imgMatch.index).replace(/^\n+|\n+$/g, '');
      if (textBefore) blocks.push({ type: 'text', content: textBefore });
      blocks.push({ type: 'image', filename: imgMatch[1] });
      lastIndex = imgMatch.index + imgMatch[0].length;
    }
    const textAfter = body.slice(lastIndex).replace(/^\n+|\n+$/g, '');
    if (textAfter) blocks.push({ type: 'text', content: textAfter });

    // Plain text body (images stripped) for backward-compat change detection
    const textOnlyBody = body.replace(/!\[\[[^\]]*\.(?:jpg|jpeg|png|gif|webp|bmp|svg)[^\]]*\]\]\n*/gi, '').trim();

    return { title, body: textOnlyBody, blocks };
  }

  /** Extract title string from serialised workspace JSON, for change detection */
  _tryParseTitle(text) {
    try { return JSON.parse(text)?.__workspace ? JSON.parse(text).title : ''; } catch { return ''; }
  }

  /**
   * Manual sync trigger
   */
  async triggerSync() {
    log.info('Manual sync triggered');
    return await this.processQueue();
  }

  /**
   * Get sync status
   */
  async getSyncStatus() {
    try {
      const queue = await syncQueue.getQueue();
      const notes = await noteRepository.getNotesArray();

      const pendingCount = queue.length;
      const syncedCount = notes.filter(n => n.metadata.syncStatus === SyncStatus.SYNCED).length;
      const errorCount = notes.filter(n => n.metadata.syncStatus === SyncStatus.ERROR).length;

      return {
        success: true,
        isSyncing: this.isSyncing,
        isOnline: this.isOnline,
        hasTargetDoc: !!this.targetFolderId,
        targetDocId: this.targetFolderId,
        pendingCount,
        syncedCount,
        errorCount,
        totalNotes: notes.length
      };

    } catch (error) {
      log.error('Failed to get sync status', error);
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
export const syncManager = new SyncManager();

// Export class for testing
export { SyncManager };
