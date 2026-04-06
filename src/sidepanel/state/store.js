/**
 * Store - Reactive state management for the side panel
 * Uses chrome.storage.onChanged for reactivity
 */

class NoteStore {
  constructor() {
    this.state = {
      notes: {},
      notesArray: [],
      syncQueue: [],
      settings: null,
      auth: null,
      isOnline: navigator.onLine,
      isSyncing: false,
      lastSyncTime: null
    };

    this.listeners = new Set();
    this.initialized = false;

    // Listen for online/offline events
    window.addEventListener('online', () => {
      this.updateState({ isOnline: true });
      console.log('[Store] Network: ONLINE');
    });

    window.addEventListener('offline', () => {
      this.updateState({ isOnline: false });
      console.log('[Store] Network: OFFLINE');
    });
  }

  /**
   * Initialize the store by loading data from chrome.storage
   */
  async init() {
    try {
      console.log('[Store] Initializing...');

      // Load initial data
      const data = await chrome.storage.local.get([
        'notes',
        'syncQueue',
        'settings',
        'auth'
      ]);

      const notes = data.notes || {};
      const notesArray = this.convertNotesToArray(notes);

      // Bootstrap auth from settings if auth key is missing but API key exists
      let auth = data.auth || null;
      if (!auth && data.settings?.obsidianApiKey) {
        auth = { token: 'configured', expiresAt: Date.now() + 86400000 * 365, email: 'Obsidian' };
        chrome.storage.local.set({ auth });
      }

      this.state = {
        notes,
        notesArray,
        syncQueue: data.syncQueue || [],
        settings: data.settings || null,
        auth,
        isOnline: navigator.onLine,
        isSyncing: false,
        lastSyncTime: null
      };

      // Listen for storage changes
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
          this.handleStorageChange(changes);
        }
      });

      this.initialized = true;
      console.log('[Store] Initialized with', notesArray.length, 'notes');

      // Notify listeners
      this.notifyListeners();

      return this.state;
    } catch (error) {
      console.error('[Store] Failed to initialize', error);
      throw error;
    }
  }

  /**
   * Handle chrome.storage changes
   */
  handleStorageChange(changes) {
    const updates = {};

    if (changes.notes) {
      const notes = changes.notes.newValue || {};
      updates.notes = notes;
      updates.notesArray = this.convertNotesToArray(notes);
      console.log('[Store] Notes updated:', updates.notesArray.length);
    }

    if (changes.syncQueue) {
      updates.syncQueue = changes.syncQueue.newValue || [];
      console.log('[Store] Sync queue updated:', updates.syncQueue.length);
    }

    if (changes.settings) {
      updates.settings = changes.settings.newValue;
      console.log('[Store] Settings updated');
    }

    if (changes.auth) {
      updates.auth = changes.auth.newValue;
      console.log('[Store] Auth updated');
    }

    if (Object.keys(updates).length > 0) {
      this.updateState(updates);
    }
  }

  /**
   * Convert notes object to sorted array
   */
  convertNotesToArray(notesObj) {
    const notesArray = Object.values(notesObj);

    // Sort by creation date (newest first)
    notesArray.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);

    return notesArray;
  }

  /**
   * Update state and notify listeners
   */
  updateState(updates) {
    this.state = { ...this.state, ...updates };
    this.notifyListeners();
  }

  /**
   * Get current state
   */
  getState() {
    return this.state;
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener) {
    this.listeners.add(listener);
    console.log('[Store] Listener subscribed, total:', this.listeners.size);

    // Call listener immediately with current state
    if (this.initialized) {
      listener(this.state);
    }

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
      console.log('[Store] Listener unsubscribed, total:', this.listeners.size);
    };
  }

  /**
   * Notify all listeners of state change
   */
  notifyListeners() {
    console.log('[Store] Notifying', this.listeners.size, 'listeners');
    this.listeners.forEach(listener => {
      try {
        listener(this.state);
      } catch (error) {
        console.error('[Store] Error in listener', error);
      }
    });
  }

  /**
   * Set syncing state
   */
  setSyncing(isSyncing) {
    this.updateState({
      isSyncing,
      lastSyncTime: isSyncing ? null : Date.now()
    });
  }

  /**
   * Get note by ID
   */
  getNote(id) {
    return this.state.notes[id] || null;
  }

  /**
   * Get all notes as array
   */
  getNotes() {
    return this.state.notesArray;
  }

  /**
   * Get pending sync count
   */
  getPendingSyncCount() {
    return this.state.syncQueue.length;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated() {
    return this.state.auth && this.state.auth.token && this.state.auth.expiresAt > Date.now();
  }
}

// Export singleton instance
export const store = new NoteStore();
