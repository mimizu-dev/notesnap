/**
 * Service Worker - Main background script
 * Coordinates message passing and acts as the central hub
 */

import { createMessageBus, MessageTypes } from '../modules/utils/message-bus.js';
import { noteRepository, SyncStatus, NoteType } from '../modules/storage/note-repository.js';
import { syncQueue, QueueAction } from '../modules/storage/sync-queue.js';
import { logger } from '../modules/utils/logger.js';
// auth handled via settings (obsidianApiKey)
import { syncManager } from './sync-manager.js';
import { obsidianClient } from './obsidian-client.js';

const log = logger.child('ServiceWorker');
const messageBus = createMessageBus('background');

// Initialize message bus
messageBus.init();

// Initialize sync manager
syncManager.init();

log.info('Service worker initialized');

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
  log.info(`Extension installed: ${details.reason}`);

  if (details.reason === 'install') {
    // Initialize storage on first install
    await initializeStorage();
  }
});

/**
 * Initialize storage with default values
 */
async function initializeStorage() {
  try {
    const { notes, syncQueue: queue, settings } = await chrome.storage.local.get([
      'notes',
      'syncQueue',
      'settings'
    ]);

    if (!notes) {
      await chrome.storage.local.set({ notes: {} });
      log.info('Initialized notes storage');
    }

    if (!queue) {
      await chrome.storage.local.set({ syncQueue: [] });
      log.info('Initialized sync queue');
    }

    if (!settings) {
      await chrome.storage.local.set({
        settings: {
          targetDocId: null,
          autoSync: true,
          ocrLanguage: 'eng',
          voiceLanguage: 'en-US',
          captureQuality: 0.9
        }
      });
      log.info('Initialized settings');
    }
  } catch (error) {
    log.error('Failed to initialize storage', error);
  }
}

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    log.info('Opened side panel');
  } catch (error) {
    log.error('Failed to open side panel', error);
  }
});

// Message handlers

/**
 * Handle CREATE_NOTE message
 */
messageBus.on(MessageTypes.CREATE_NOTE, async (payload, sender) => {
  try {
    log.info('Creating note', payload);

    const note = await noteRepository.createNote(payload);

    // Add to sync queue
    await syncQueue.addToQueue(note.id, QueueAction.CREATE);

    log.info(`Note created: ${note.id}`);

    return { success: true, note };
  } catch (error) {
    log.error('Failed to create note', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle UPDATE_NOTE message
 */
messageBus.on(MessageTypes.UPDATE_NOTE, async (payload, sender) => {
  try {
    log.info(`Updating note: ${payload.id}`);

    const note = await noteRepository.updateNote(payload.id, payload.updates);

    // Always queue for sync — updateNote resets status to PENDING before we can check it
    await syncQueue.addToQueue(note.id, QueueAction.UPDATE);

    log.info(`Note updated: ${note.id}`);

    return { success: true, note };
  } catch (error) {
    log.error('Failed to update note', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle DELETE_NOTE message
 */
messageBus.on(MessageTypes.DELETE_NOTE, async (payload, sender) => {
  try {
    log.info(`Deleting note: ${payload.id}`);

    const note = await noteRepository.getNote(payload.id);

    // Delete from Obsidian immediately (before local delete)
    if (note) {
      if (note.metadata.googleDocId) {
        try {
          await obsidianClient.deleteFile(note.metadata.googleDocId);
          log.info('Deleted note file from Obsidian');
        } catch (err) {
          log.warn('Obsidian note delete failed (non-fatal):', err.message);
        }
      }
      // Also delete attachments
      const imagePaths = syncManager.getAttachmentPaths(note, syncManager.targetFolderId || '');
      for (const imagePath of imagePaths) {
        try {
          await obsidianClient.deleteFile(imagePath);
          log.info('Deleted attachment from Obsidian:', imagePath);
        } catch (err) {
          log.warn('Obsidian attachment delete failed (non-fatal):', err.message);
        }
      }
    }

    await noteRepository.deleteNote(payload.id);

    log.info(`Note deleted: ${payload.id}`);

    return { success: true };
  } catch (error) {
    log.error('Failed to delete note', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle GET_NOTES message
 */
messageBus.on(MessageTypes.GET_NOTES, async (payload, sender) => {
  try {
    const notes = await noteRepository.getNotesArray();
    log.debug(`Retrieved ${notes.length} notes`);

    return { success: true, notes };
  } catch (error) {
    log.error('Failed to get notes', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle GET_SETTINGS message
 */
messageBus.on(MessageTypes.GET_SETTINGS, async (payload, sender) => {
  try {
    const settings = await chrome.storage.local.get('settings');
    log.debug('Retrieved settings');

    return { success: true, settings: settings.settings };
  } catch (error) {
    log.error('Failed to get settings', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle UPDATE_SETTINGS message
 */
messageBus.on(MessageTypes.UPDATE_SETTINGS, async (payload, sender) => {
  try {
    log.info('Updating settings', payload);

    const { settings: currentSettings } = await chrome.storage.local.get('settings');
    const updatedSettings = { ...currentSettings, ...payload };

    await chrome.storage.local.set({ settings: updatedSettings });

    log.info('Settings updated');

    return { success: true, settings: updatedSettings };
  } catch (error) {
    log.error('Failed to update settings', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle CAPTURE_FRAME message - Capture screenshot and return data without creating a note
 */
messageBus.on(MessageTypes.CAPTURE_FRAME, async (payload, sender) => {
  try {
    log.info('Frame capture requested from side panel');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 });
    const base64Length = dataUrl.length - dataUrl.indexOf(',') - 1;
    const sizeKB = Math.round((base64Length * 3) / 4 / 1024);

    return {
      success: true,
      imageDataUrl: dataUrl,
      sizeKB,
      pageUrl: tab.url,
      pageTitle: tab.title,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    log.error('Failed to handle frame capture', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle FRAME_CAPTURED message - Frame captured from content script
 */
messageBus.on(MessageTypes.FRAME_CAPTURED, async (payload, sender) => {
  try {
    log.info('Frame captured, processing...');

    return await processFrameCapture(payload);

  } catch (error) {
    log.error('Failed to process captured frame', error);
    return { success: false, error: error.message };
  }
});

/**
 * Process captured frame and perform OCR
 */
async function processFrameCapture(captureResult) {
  try {
    const { frameData, videoMetadata, pageMetadata } = captureResult;

    log.info('Processing captured frame', {
      size: `${frameData.sizeKB} KB`,
      dimensions: `${frameData.width}x${frameData.height}`
    });

    // Create note with captured frame (OCR runs in side panel, not here)
    const noteData = {
      type: NoteType.CAPTURE,
      text: '',
      ocrText: '',
      imageDataUrl: frameData.dataUrl,
      videoUrl: pageMetadata.url,
      videoTimestamp: frameData.timestamp,
      pageTitle: pageMetadata.title,
      pageUrl: pageMetadata.url
    };

    const note = await noteRepository.createNote(noteData);

    // Add to sync queue
    await syncQueue.addToQueue(note.id, QueueAction.CREATE);

    log.info(`Note created from capture: ${note.id}`);

    return {
      success: true,
      note: note,
      ocr: {
        text: '',
        confidence: 0,
        duration: 0
      }
    };

  } catch (error) {
    log.error('Failed to process frame capture', error);
    throw error;
  }
}

/**
 * Handle START_OCR message - Perform OCR on existing image
 */
messageBus.on(MessageTypes.START_OCR, async (payload, sender) => {
  try {
    log.info('OCR requested for note', payload.noteId);

    const note = await noteRepository.getNote(payload.noteId);

    if (!note || !note.content.imageDataUrl) {
      throw new Error('Note not found or has no image');
    }

    // OCR must run in the side panel (service workers cannot use Web Workers)
    return {
      success: false,
      error: 'OCR is not supported in the service worker. Run OCR from the side panel.'
    };

  } catch (error) {
    log.error('Failed to perform OCR', error);
    return { success: false, error: error.message };
  }
});

/**
 * Obsidian Configuration Handlers
 */

messageBus.on(MessageTypes.REQUEST_AUTH, async (payload, sender) => {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const updated = {
      ...settings,
      obsidianUrl: payload.url || 'http://localhost:27123',
      obsidianApiKey: payload.apiKey || '',
      obsidianVaultName: payload.vaultName || settings?.obsidianVaultName || ''
    };
    await chrome.storage.local.set({ settings: updated });

    const test = await obsidianClient.testConnection();
    if (!test.success) {
      return { success: false, error: `Make sure Obsidian is open and the Local REST API plugin is enabled.${test.error ? ` (${test.error})` : ''}` };
    }

    // Write auth state so the store picks it up reactively
    await chrome.storage.local.set({
      auth: {
        token: 'configured',
        expiresAt: Date.now() + 86400000 * 365,
        email: 'Obsidian'
      }
    });

    // Pull existing notes from Obsidian in the background (non-blocking)
    syncManager.pullFromObsidian().catch(e => log.warn('Post-auth pull failed:', e.message));

    return { success: true, email: 'Obsidian' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

messageBus.on(MessageTypes.GET_AUTH_STATUS, async (payload, sender) => {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const isConfigured = !!(settings?.obsidianApiKey);
    // Ensure auth storage is in sync with settings
    if (isConfigured) {
      const { auth } = await chrome.storage.local.get('auth');
      if (!auth) {
        await chrome.storage.local.set({
          auth: { token: 'configured', expiresAt: Date.now() + 86400000 * 365, email: 'Obsidian' }
        });
      }
    }
    return {
      success: true,
      isAuthenticated: isConfigured,
      token: isConfigured ? 'configured' : null,
      expiresAt: isConfigured ? Date.now() + 86400000 * 365 : 0,
      email: isConfigured ? 'Obsidian' : null
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

messageBus.on(MessageTypes.LOGOUT, async (payload, sender) => {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const updated = { ...settings, obsidianApiKey: '', obsidianUrl: '' };
    await chrome.storage.local.set({ settings: updated, auth: null });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Google Docs Sync Handlers
 */

/**
 * Handle PUSH_NOTE message - Push a single note to Obsidian
 */
messageBus.on(MessageTypes.PUSH_NOTE, async (payload, sender) => {
  try {
    const { noteId } = payload;
    const note = await noteRepository.getNote(noteId);
    if (!note) return { success: false, error: 'Note not found' };

    await noteRepository.updateNote(noteId, { metadata: { syncStatus: SyncStatus.SYNCING } });

    const result = await syncManager.syncNoteToDoc(note);
    if (result.success) {
      const updateObj = {
        metadata: {
          syncStatus: SyncStatus.SYNCED,
          lastSyncedAt: Date.now(),
          googleDocId: result.documentId || note.metadata.googleDocId || null
        }
      };
      if (result.updatedWorkspace) {
        updateObj.content = { text: result.updatedWorkspace };
      }
      await noteRepository.updateNote(noteId, updateObj);
      await syncQueue.removeFromQueue(noteId);
      log.info(`Note pushed to Obsidian: ${noteId}`);
      return { success: true };
    } else {
      await noteRepository.updateNote(noteId, { metadata: { syncStatus: SyncStatus.ERROR } });
      return { success: false, error: result.error };
    }
  } catch (error) {
    log.error('Failed to push note', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle PULL_FROM_OBSIDIAN message - Import notes from vault without pushing
 */
messageBus.on(MessageTypes.PULL_FROM_OBSIDIAN, async (payload, sender) => {
  try {
    const result = await syncManager.pullFromObsidian(payload?.force || false);
    return { success: true, imported: result?.imported || 0, updated: result?.updated || 0 };
  } catch (error) {
    log.error('Failed to pull from Obsidian', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle TRIGGER_SYNC message - Manual sync trigger
 */
messageBus.on(MessageTypes.TRIGGER_SYNC, async (payload, sender) => {
  try {
    log.info('Manual sync triggered');
    const result = await syncManager.triggerSync();
    // result already includes imported/updated from pullFromObsidian inside processQueue
    return result;
  } catch (error) {
    log.error('Failed to trigger sync', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle GET_SYNC_STATUS message - Get sync status
 */
messageBus.on(MessageTypes.GET_SYNC_STATUS, async (payload, sender) => {
  try {
    const status = await syncManager.getSyncStatus();

    return status;

  } catch (error) {
    log.error('Failed to get sync status', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle SET_TARGET_DOCUMENT message - Set target Google Doc
 */
messageBus.on(MessageTypes.SET_TARGET_DOCUMENT, async (payload, sender) => {
  try {
    log.info('Setting target document', { documentId: payload.documentId });

    const result = await syncManager.setTargetDocument(payload.documentId, payload.folderName || '');

    return result;

  } catch (error) {
    log.error('Failed to set target document', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle CREATE_TARGET_DOCUMENT message - Create and set target Google Doc
 */
messageBus.on(MessageTypes.CREATE_TARGET_DOCUMENT, async (payload, sender) => {
  try {
    log.info('Creating target document', { title: payload.title });

    const result = await syncManager.createAndSetTargetDocument(payload.title);

    return result;

  } catch (error) {
    log.error('Failed to create target document', error);
    return { success: false, error: error.message };
  }
});

/**
 * Handle LIST_DOCUMENTS message - List user's Google Docs
 */
messageBus.on(MessageTypes.LIST_DOCUMENTS, async (payload, sender) => {
  try {
    log.info('Listing vault folders');
    const result = await obsidianClient.listVaultFolders();
    return { success: result.success, folders: result.folders || [] };
  } catch (error) {
    log.error('Failed to list vault folders', error);
    return { success: false, error: error.message, folders: [] };
  }
});

/**
 * Handle READ_DOCUMENT_NOTES message - Read notes from a Google Doc
 */
messageBus.on(MessageTypes.READ_DOCUMENT_NOTES, async (payload, sender) => {
  try {
    log.info('Listing notes from Obsidian folder:', payload.documentId);

    const result = await obsidianClient.listFolder(payload.documentId);

    const notes = (result.files || []).map(filename => ({
      id: `obsidian-${filename}`,
      type: 'workspace',
      content: { text: '', imageDataUrl: null },
      metadata: {
        pageTitle: filename.replace(/\.md$/, ''),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        syncStatus: 'synced',
        googleDocId: payload.documentId ? `${payload.documentId}/${filename}` : filename,
        fromFolder: true
      }
    }));

    return { success: true, notes };

  } catch (error) {
    log.error('Failed to list Obsidian folder:', error);
    return { success: false, error: error.message };
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync-retry') {
    log.info('Sync retry alarm triggered');
    await syncManager.processQueue();
  }
});

// Keep service worker alive by responding to messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Message bus handles all incoming messages
  // This listener just keeps the async channel open
  return true;
});

log.info('Service worker ready');
