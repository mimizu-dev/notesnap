/**
 * Message Bus for type-safe communication between extension contexts
 * (Content Script, Service Worker, Side Panel)
 */

import { logger } from './logger.js';

// Message type constants
export const MessageTypes = {
  // Video capture messages
  CAPTURE_FRAME: 'CAPTURE_FRAME',
  FRAME_CAPTURED: 'FRAME_CAPTURED',
  VIDEO_DETECTED: 'VIDEO_DETECTED',
  GET_VIDEO_STATUS: 'GET_VIDEO_STATUS',
  CHECK_VIDEO_READY: 'CHECK_VIDEO_READY',

  // Note management messages
  CREATE_NOTE: 'CREATE_NOTE',
  UPDATE_NOTE: 'UPDATE_NOTE',
  DELETE_NOTE: 'DELETE_NOTE',
  GET_NOTES: 'GET_NOTES',
  NOTES_UPDATED: 'NOTES_UPDATED',

  // OCR messages
  START_OCR: 'START_OCR',
  OCR_PROGRESS: 'OCR_PROGRESS',
  OCR_COMPLETE: 'OCR_COMPLETE',
  OCR_ERROR: 'OCR_ERROR',

  // Voice messages
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  VOICE_TRANSCRIBED: 'VOICE_TRANSCRIBED',

  // Auth messages
  GET_AUTH_STATUS: 'GET_AUTH_STATUS',
  REQUEST_AUTH: 'REQUEST_AUTH',
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILED: 'AUTH_FAILED',
  LOGOUT: 'LOGOUT',

  // Sync messages
  SYNC_NOW: 'SYNC_NOW',
  TRIGGER_SYNC: 'TRIGGER_SYNC',
  PULL_FROM_OBSIDIAN: 'PULL_FROM_OBSIDIAN',
  PUSH_NOTE: 'PUSH_NOTE',
  GET_SYNC_STATUS: 'GET_SYNC_STATUS',
  SYNC_PROGRESS: 'SYNC_PROGRESS',
  SYNC_COMPLETE: 'SYNC_COMPLETE',
  SYNC_ERROR: 'SYNC_ERROR',

  // Google Docs messages
  SET_TARGET_DOCUMENT: 'SET_TARGET_DOCUMENT',
  CREATE_TARGET_DOCUMENT: 'CREATE_TARGET_DOCUMENT',
  LIST_DOCUMENTS: 'LIST_DOCUMENTS',
  READ_DOCUMENT_NOTES: 'READ_DOCUMENT_NOTES',

  // Settings messages
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',

  // Error messages
  ERROR: 'ERROR'
};

/**
 * Message Bus class for sending and receiving messages
 */
export class MessageBus {
  constructor(context = 'unknown') {
    this.context = context;
    this.log = logger.child('MessageBus');
    this.listeners = new Map();
  }

  /**
   * Create a typed message
   */
  createMessage(type, payload = {}) {
    return {
      type,
      payload,
      sender: this.context,
      timestamp: Date.now()
    };
  }

  /**
   * Send message to service worker (background)
   */
  async sendToBackground(type, payload = {}) {
    const message = this.createMessage(type, payload);
    this.log.debug(`Sending to background: ${type}`, payload);

    try {
      const response = await chrome.runtime.sendMessage(message);
      this.log.debug(`Response from background: ${type}`, response);
      return response;
    } catch (error) {
      this.log.error(`Failed to send message ${type}`, error);
      throw error;
    }
  }

  /**
   * Send message to content script
   */
  async sendToContent(tabId, type, payload = {}) {
    const message = this.createMessage(type, payload);
    this.log.debug(`Sending to content script (tab ${tabId}): ${type}`, payload);

    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      this.log.debug(`Response from content: ${type}`, response);
      return response;
    } catch (error) {
      this.log.error(`Failed to send message to content ${type}`, error);
      throw error;
    }
  }

  /**
   * Send message to all tabs
   */
  async broadcastToAllTabs(type, payload = {}) {
    const message = this.createMessage(type, payload);
    this.log.debug(`Broadcasting to all tabs: ${type}`, payload);

    try {
      const tabs = await chrome.tabs.query({});
      const promises = tabs.map(tab =>
        chrome.tabs.sendMessage(tab.id, message).catch(() => null)
      );
      return await Promise.all(promises);
    } catch (error) {
      this.log.error(`Failed to broadcast message ${type}`, error);
      throw error;
    }
  }

  /**
   * Register a message listener
   */
  on(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
    this.log.debug(`Registered listener for: ${type}`);
  }

  /**
   * Unregister a message listener
   */
  off(type, handler) {
    if (this.listeners.has(type)) {
      const handlers = this.listeners.get(type);
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
        this.log.debug(`Unregistered listener for: ${type}`);
      }
    }
  }

  /**
   * Handle incoming message
   */
  async handleMessage(message, sender, sendResponse) {
    if (!message || !message.type) {
      this.log.warn('Received invalid message', message);
      sendResponse({ success: false, error: 'Invalid message' });
      return;
    }

    this.log.debug(`Received message: ${message.type}`, message.payload);

    const handlers = this.listeners.get(message.type);
    if (!handlers || handlers.length === 0) {
      this.log.warn(`No handlers registered for message type: ${message.type}`);
      sendResponse({ success: false, error: `No handler for ${message.type}` });
      return;
    }

    try {
      // Call all registered handlers and send back the last response
      let response;
      for (const handler of handlers) {
        response = await handler(message.payload, sender);
      }
      sendResponse(response);
    } catch (error) {
      this.log.error(`Error handling message ${message.type}`, error);
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * Initialize message listener
   */
  init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep channel open for async response
    });
    this.log.info(`MessageBus initialized for context: ${this.context}`);
  }
}

// Export helper function to create message bus instances
export function createMessageBus(context) {
  return new MessageBus(context);
}
