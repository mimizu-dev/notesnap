/**
 * Side Panel - Workspace-based UI
 */

import { store } from './state/store.js';
import { createMessageBus, MessageTypes } from '../modules/utils/message-bus.js';
import { createSpeechRecognizer, isSpeechRecognitionSupported } from '../modules/speech/speech-recognizer.js';

const messageBus = createMessageBus('sidepanel');
messageBus.init();

let speechRecognizer = null;
// workspace = { noteId, title, captureItems: { [itemId]: captureItem } }
// Editor text lives in #editor-content (contenteditable)
let workspace = null;
let searchQuery = '';
let filterType = 'all';
let editorShowDeleted = false;
let editorDirty = false;

// DOM elements
const el = {
  btnNewNote: document.getElementById('btn-new-note'),
  btnCapture: document.getElementById('btn-capture'),
  btnVoice: document.getElementById('btn-voice'),
  btnAuth: document.getElementById('btn-auth'),
  btnSync: document.getElementById('btn-sync'),
  pendingCount: document.getElementById('pending-count'),

  searchInput: document.getElementById('search-input'),
  filterSelect: document.getElementById('filter-select'),
  notesContainer: document.getElementById('notes-container'),
  emptyState: document.getElementById('empty-state'),
  loading: document.getElementById('loading'),
  toastContainer: document.getElementById('toast-container'),

  docName: document.getElementById('doc-name'),
  btnChangeDoc: document.getElementById('btn-change-doc'),

  // Tabs
  tabBtnList: document.getElementById('tab-btn-list'),
  tabBtnEditor: document.getElementById('tab-btn-editor'),
  panelList: document.getElementById('panel-list'),
  panelEditor: document.getElementById('panel-editor'),

  // Editor
  editorTitle: document.getElementById('editor-title'),
  editorContent: document.getElementById('editor-content'),
  btnDiscard: document.getElementById('btn-discard'),
  btnSaveNote: document.getElementById('btn-save-note'),

  // Document modal
  docModal: document.getElementById('doc-modal'),
  docModalClose: document.getElementById('doc-modal-close'),
  newDocTitle: document.getElementById('new-doc-title'),
  btnCreateDoc: document.getElementById('btn-create-doc'),
  docListLoading: document.getElementById('doc-list-loading'),
  docList: document.getElementById('doc-list'),
  docListEmpty: document.getElementById('doc-list-empty'),
  docCancel: document.getElementById('doc-cancel'),

  // Voice
  voiceModal: document.getElementById('voice-modal'),
  voiceModalClose: document.getElementById('voice-modal-close'),
  voiceIndicator: document.getElementById('voice-indicator'),
  voiceStatusText: document.getElementById('voice-status-text'),
  voiceFinalTranscript: document.getElementById('voice-final-transcript'),
  voiceInterimTranscript: document.getElementById('voice-interim-transcript'),
  voiceLanguage: document.getElementById('voice-language'),
  voiceNotSupported: document.getElementById('voice-not-supported'),
  voiceRecord: document.getElementById('voice-record'),
  voiceRecordIcon: document.getElementById('voice-record-icon'),
  voiceRecordText: document.getElementById('voice-record-text'),
  voiceSave: document.getElementById('voice-save'),
  voiceCancel: document.getElementById('voice-cancel'),
};

// ===================== INIT =====================

async function init() {
  await store.init();
  store.subscribe(handleStateChange);
  setupEventListeners();
  if (!isSpeechRecognitionSupported()) {
    el.btnVoice.disabled = true;
    el.btnVoice.title = 'Speech recognition not supported in this browser';
  }
}

/** Return the first direct child of editorContent whose top-half is below clientY. */
function _findDropInsertBefore(clientY) {
  const ce = el.editorContent;
  for (const child of ce.children) {
    if (child.classList.contains('ce-drop-line')) continue;
    const rect = child.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return child;
  }
  return null;
}

function setupEventListeners() {
  el.btnNewNote.addEventListener('click', handleNewNote);
  el.btnCapture.addEventListener('click', handleCapture);
  el.btnVoice.addEventListener('click', handleVoice);
  el.btnAuth.addEventListener('click', handleAuth);
  el.btnSync.addEventListener('click', handleSync);

  el.searchInput.addEventListener('input', (e) => { searchQuery = e.target.value; renderNotes(store.getState().notesArray); });
  el.filterSelect.addEventListener('change', (e) => { filterType = e.target.value; renderNotes(store.getState().notesArray); });

  // Tab switching
  el.tabBtnList.addEventListener('click', async () => {
    await refreshNotesFromStorage();
    switchTab('list');
  });
  el.tabBtnEditor.addEventListener('click', () => {
    // If no active workspace (e.g. after a save), reset to a blank new note so
    // the editor is always in a functional state when entered directly.
    if (!workspace && !editorShowDeleted) {
      workspace = { noteId: null, title: '', captureItems: {} };
      el.editorTitle.value = '';
      el.editorContent.innerHTML = '';
    }
    switchTab('editor');
  });

  // Editor
  el.editorContent.addEventListener('keydown', handleEditorKeydown);
  el.btnDiscard.addEventListener('click', discardWorkspace);
  el.btnSaveNote.addEventListener('click', saveWorkspace);

  // Drag-and-drop reordering of capture blocks
  el.editorContent.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-capture-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const ce = el.editorContent;
    ce.querySelectorAll('.ce-drop-line').forEach(d => d.remove());
    const line = document.createElement('div');
    line.className = 'ce-drop-line';
    const insertBefore = _findDropInsertBefore(e.clientY);
    if (insertBefore) ce.insertBefore(line, insertBefore);
    else ce.appendChild(line);
  });
  el.editorContent.addEventListener('dragleave', (e) => {
    if (!el.editorContent.contains(e.relatedTarget)) {
      el.editorContent.querySelectorAll('.ce-drop-line').forEach(d => d.remove());
    }
  });
  el.editorContent.addEventListener('drop', (e) => {
    e.preventDefault();
    const itemId = e.dataTransfer.getData('text/x-capture-id');
    if (!itemId) return;
    const ce = el.editorContent;
    ce.querySelectorAll('.ce-drop-line').forEach(d => d.remove());
    const draggedBlock = ce.querySelector(`.ce-capture[data-item-id="${itemId}"]`);
    if (!draggedBlock) return;
    const draggedSpacer = draggedBlock.nextElementSibling;
    const hasSpacer = draggedSpacer && draggedSpacer.tagName === 'DIV' && draggedSpacer.innerHTML === '<br>';
    // Temporarily detach to avoid counting in insertion point calc
    draggedBlock.remove();
    if (hasSpacer) draggedSpacer.remove();
    const insertBefore = _findDropInsertBefore(e.clientY);
    if (insertBefore) {
      ce.insertBefore(draggedBlock, insertBefore);
      if (hasSpacer) ce.insertBefore(draggedSpacer, insertBefore);
    } else {
      ce.appendChild(draggedBlock);
      if (hasSpacer) ce.appendChild(draggedSpacer);
    }
    if (workspace) setEditorDirty(true);
  });

  // Mark editor dirty whenever content changes
  el.editorContent.addEventListener('input', () => { if (workspace) setEditorDirty(true); });
  el.editorTitle.addEventListener('input', () => { if (workspace) setEditorDirty(true); });

  // Format toolbar — mousedown + preventDefault to keep contenteditable selection
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyFormat(btn.dataset.fmt);
    });
  });

  // Document modal
  el.btnChangeDoc.addEventListener('click', openDocumentModal);
  el.docModalClose.addEventListener('click', closeDocumentModal);
  el.docCancel.addEventListener('click', closeDocumentModal);
  el.btnCreateDoc.addEventListener('click', handleCreateDocument);
  el.docModal.addEventListener('click', (e) => { if (e.target === el.docModal) closeDocumentModal(); });

  // Voice modal
  el.voiceModalClose.addEventListener('click', closeVoiceModal);
  el.voiceCancel.addEventListener('click', closeVoiceModal);
  el.voiceRecord.addEventListener('click', handleVoiceRecord);
  el.voiceSave.addEventListener('click', handleSaveVoice);
  el.voiceModal.addEventListener('click', (e) => { if (e.target === el.voiceModal) closeVoiceModal(); });
  el.voiceLanguage.addEventListener('change', () => { if (speechRecognizer) { speechRecognizer.stop(); speechRecognizer = null; } });

  // Obsidian config modal
  const obsidianModal = document.getElementById('obsidian-config-modal');
  if (obsidianModal) {
    document.getElementById('obsidian-config-close').addEventListener('click', closeObsidianConfigModal);
    document.getElementById('obsidian-config-cancel').addEventListener('click', closeObsidianConfigModal);
    document.getElementById('obsidian-step-next').addEventListener('click', () => showObsidianStep(2));
    document.getElementById('obsidian-step-back').addEventListener('click', () => showObsidianStep(1));
    document.getElementById('obsidian-config-test').addEventListener('click', handleTestObsidianConnection);
    document.getElementById('obsidian-config-save').addEventListener('click', handleSaveObsidianConfig);
    obsidianModal.addEventListener('click', (e) => { if (e.target === obsidianModal) closeObsidianConfigModal(); });
  }
}

// ===================== STATE =====================

function handleStateChange(state) {
  updateSyncStatus(state);
  updateAuthStatus(state.auth);
  renderNotes(state.notesArray);
}

function updateSyncStatus(state) {
  const pending = state.syncQueue.length;
  const syncBtn = el.btnSync;
  const isAuthenticated = state.auth && state.auth.token && state.auth.expiresAt > Date.now();

  // Spinning animation
  if (state.isSyncing) {
    syncBtn.classList.add('syncing');
    syncBtn.classList.remove('sync-clicked');
  } else {
    syncBtn.classList.remove('syncing');
  }

  // Badge removed — sync button no longer shows pending count
  el.pendingCount.style.display = 'none';

  // Enable sync button whenever authenticated and online
  syncBtn.disabled = !(isAuthenticated && state.isOnline && !state.isSyncing);
  syncBtn.title = 'Pull latest notes from Obsidian';
}

async function updateAuthStatus(auth) {
  const isAuthenticated = auth && auth.token && auth.expiresAt > Date.now();
  if (isAuthenticated) {
    el.btnAuth.classList.add('conn-connected');
    el.btnAuth.title = 'Obsidian connected — click to disconnect';
    await loadTargetDocumentInfo();
  } else {
    el.btnAuth.classList.remove('conn-connected');
    el.btnAuth.title = 'Connect to Obsidian';
    el.docName.textContent = 'No folder';
  }
}

// ===================== TAB SWITCHING =====================

function switchTab(tab) {
  if (tab === 'list') {
    el.tabBtnList.classList.add('active');
    el.tabBtnEditor.classList.remove('active');
    el.panelList.classList.remove('hidden');
    el.panelEditor.classList.add('hidden');
  } else {
    el.tabBtnEditor.classList.add('active');
    el.tabBtnList.classList.remove('active');
    el.panelEditor.classList.remove('hidden');
    el.panelList.classList.add('hidden');
    // Focus editor after switch
    setTimeout(() => el.editorContent.focus(), 50);
  }
}

// ===================== NOTES LIST REFRESH =====================

async function refreshNotesFromStorage() {
  try {
    // Render what's in local storage immediately
    const data = await chrome.storage.local.get('notes');
    const notes = data.notes || {};
    const notesArray = Object.values(notes).sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
    renderNotes(notesArray);

    // If the note currently open in the editor was deleted externally, mark it deleted
    if (workspace?.noteId && !notes[workspace.noteId]) {
      workspace = null;
      showEditorDeletedState(true);
    }

    // If authenticated and online, pull latest notes from Obsidian vault in the background.
    // The store's chrome.storage.onChanged listener will re-render the list automatically
    // when the pull writes new/updated notes to storage.
    const state = store.getState();
    if (state.isOnline && state.auth?.token && state.auth.expiresAt > Date.now()) {
      messageBus.sendToBackground(MessageTypes.PULL_FROM_OBSIDIAN).catch(() => {});
    }
  } catch (e) {
    console.error('[refreshNotesFromStorage]', e);
  }
}

// ===================== EDITOR DELETED STATE =====================

function showEditorDeletedState(show) {
  editorShowDeleted = show;

  el.editorContent.contentEditable = show ? 'false' : 'true';
  el.editorTitle.disabled = show;
  el.btnSaveNote.disabled = show;
  document.querySelectorAll('.fmt-btn').forEach(btn => { btn.disabled = show; });

  let notice = document.getElementById('editor-deleted-notice');
  if (show) {
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'editor-deleted-notice';
      notice.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;color:#856404;padding:8px 12px;font-size:12px;text-align:center;flex-shrink:0;';
      notice.textContent = 'This note has been deleted and can no longer be edited. Click ✏️ to create a new note or select an existing one from the list.';
      el.panelEditor.insertBefore(notice, el.panelEditor.firstChild);
    }
    notice.style.display = 'block';
    el.editorContent.style.opacity = '0.45';
    el.editorTitle.style.opacity = '0.45';
  } else {
    if (notice) notice.style.display = 'none';
    el.editorContent.style.opacity = '';
    el.editorTitle.style.opacity = '';
  }
}

// ===================== WORKSPACE =====================

function genItemId() {
  return `item-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
}

function handleNewNote() {
  // If there's an existing note open, confirm before discarding it
  if (workspace && workspace.noteId) {
    if (!confirm('Leave the current note without saving?')) return;
  }
  showEditorDeletedState(false);
  setEditorDirty(false);
  workspace = { noteId: null, title: '', captureItems: {} };
  el.editorTitle.value = '';
  el.editorContent.innerHTML = '';
  switchTab('editor');
  setTimeout(() => el.editorTitle.focus(), 50);
}

async function openNoteInEditor(note) {
  showEditorDeletedState(false);
  setEditorDirty(false);
  let items = parseLocalWorkspaceItems(note);
  let title = getLocalWorkspaceTitle(note);

  // Fetch latest from Obsidian if synced
  if (note.metadata.googleDocId) {
    try {
      showLoading(true);
      const markdown = await fetchNoteMarkdownFromObsidian(note.metadata.googleDocId);
      if (markdown) {
        const parsed = await parseObsidianMarkdownToItems(markdown, note);
        // Only replace items if Obsidian produced something; otherwise keep
        // local items (e.g. capture-only notes where image refs can't be resolved)
        if (parsed.items.length > 0) {
          items = parsed.items;
        }
        title = parsed.title || title;
      }
    } catch (e) {
      console.warn('[openNoteInEditor] Could not fetch from Obsidian:', e);
    } finally {
      showLoading(false);
    }
  }

  workspace = { noteId: note.id, title, captureItems: {} };
  el.editorTitle.value = title;
  renderItemsInEditor(items);
  switchTab('editor');
}

// ===================== EDITOR RENDERING =====================

/**
 * Render items[] into the contenteditable editor.
 * Capture items become .ce-capture blocks (not editable inline).
 * Text/voice items become text lines.
 */
function renderItemsInEditor(items) {
  const ce = el.editorContent;
  ce.innerHTML = '';
  workspace.captureItems = {};

  if (!items || items.length === 0) {
    const div = document.createElement('div');
    div.innerHTML = '<br>';
    ce.appendChild(div);
    return;
  }

  // Group consecutive text/voice items, break on captures
  let textBuffer = [];

  function flushText() {
    if (textBuffer.length === 0) return;
    const text = textBuffer.join('\n');
    textBuffer = [];
    // Split into lines and create divs
    const lines = text.split('\n');
    for (const line of lines) {
      const div = document.createElement('div');
      if (line) {
        div.textContent = line;
      } else {
        div.innerHTML = '<br>';
      }
      ce.appendChild(div);
    }
  }

  for (const item of items) {
    if (item.type === 'capture') {
      flushText();
      workspace.captureItems[item.id] = item;
      ce.appendChild(createCaptureBlock(item));
      // Empty line after capture for cursor placement
      const spacer = document.createElement('div');
      spacer.innerHTML = '<br>';
      ce.appendChild(spacer);
    } else if (item.type === 'voice') {
      const lines = (item.content || '').split('\n').map(l => '> ' + l);
      textBuffer.push(...lines);
    } else {
      textBuffer.push(item.content || '');
    }
  }
  flushText();

  // Ensure at least one editable div
  if (!ce.querySelector('div:not(.ce-capture)')) {
    const div = document.createElement('div');
    div.innerHTML = '<br>';
    ce.appendChild(div);
  }
}

/**
 * Create a non-editable capture image block for embedding in the editor.
 */
function createCaptureBlock(item) {
  const wrap = document.createElement('div');
  wrap.className = 'ce-capture';
  wrap.contentEditable = 'false';
  wrap.draggable = true;
  wrap.dataset.itemId = item.id;

  wrap.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/x-capture-id', item.id);
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('ce-capture-dragging');
  });
  wrap.addEventListener('dragend', () => {
    wrap.classList.remove('ce-capture-dragging');
    el.editorContent.querySelectorAll('.ce-drop-line').forEach(d => d.remove());
  });

  const img = document.createElement('img');
  img.src = item.imageDataUrl;
  img.alt = item.pageTitle || 'Screenshot';
  wrap.appendChild(img);

  const bar = document.createElement('div');
  bar.className = 'ce-capture-bar';

  // Drag handle
  const handle = document.createElement('span');
  handle.className = 'ce-capture-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  bar.appendChild(handle);

  const src = document.createElement('span');
  src.className = 'ce-capture-source';
  // Strip browser-prefixed "Extension - " or "扩展程序 - " from extension page titles
  const rawTitle = item.pageTitle || '';
  src.textContent = rawTitle.replace(/^(?:扩展程序|Extension)\s*[-–—]\s*/i, '') || '📸 Screenshot';
  bar.appendChild(src);

  const delBtn = document.createElement('button');
  delBtn.className = 'ce-capture-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Remove screenshot';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    delete workspace.captureItems[item.id];
    // Remove the capture block and following spacer if it's a <div><br></div>
    const next = wrap.nextElementSibling;
    wrap.remove();
    if (next && next.tagName === 'DIV' && next.innerHTML === '<br>') next.remove();
  });
  bar.appendChild(delBtn);
  wrap.appendChild(bar);

  return wrap;
}

/**
 * Serialize the contenteditable DOM back to items[].
 * Capture blocks → individual capture items.
 * Everything else → one text item (preserving order).
 */
function serializeEditorToItems() {
  const ce = el.editorContent;
  const items = [];
  let textLines = [];

  function flushText() {
    // Trim trailing blank lines
    while (textLines.length && !textLines[textLines.length - 1].trim()) textLines.pop();
    // Trim leading blank lines
    while (textLines.length && !textLines[0].trim()) textLines.shift();
    const text = textLines.join('\n').trim();
    if (text) {
      items.push({ id: genItemId(), type: 'text', content: text, timestamp: Date.now() });
    }
    textLines = [];
  }

  for (const node of ce.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains('ce-capture')) {
        flushText();
        const captureItem = workspace.captureItems[node.dataset.itemId];
        if (captureItem) items.push({ ...captureItem });
        continue;
      }
      if (node.tagName === 'BR') {
        textLines.push('');
        continue;
      }
      // div, p, etc. — get inner text.
      // Strip trailing newlines that Chrome's innerText adds for block elements
      // containing <br> (e.g. the spacer after a capture block), which would
      // otherwise produce an extra blank line in the pushed markdown.
      const rawText = node.innerText !== undefined ? node.innerText : node.textContent || '';
      textLines.push(rawText.replace(/\n+$/, ''));
    } else if (node.nodeType === Node.TEXT_NODE) {
      textLines.push(node.textContent || '');
    }
  }
  flushText();

  return items;
}

// ===================== OBSIDIAN SYNC HELPERS =====================

async function fetchNoteMarkdownFromObsidian(vaultPath) {
  const { settings } = await chrome.storage.local.get('settings');
  const baseUrl = (settings?.obsidianUrl || 'http://localhost:27123').replace(/\/$/, '');
  const apiKey = settings?.obsidianApiKey || '';
  if (!apiKey) return null;

  const encodedPath = vaultPath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${baseUrl}/vault/${encodedPath}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!res.ok) return null;
  return await res.text();
}

function parseLocalWorkspaceItems(note) {
  try {
    const parsed = JSON.parse(note.content.text);
    if (parsed?.__workspace) {
      const items = parsed.items || [];
      // Recover a capture image from the top-level imageDataUrl field when it is
      // missing from workspace items.  This can happen for notes whose items were
      // overwritten by an older version of pullFromObsidian that stripped captures.
      if (note.content.imageDataUrl && !items.some(i => i.type === 'capture')) {
        items.push({
          id: genItemId(),
          type: 'capture',
          imageDataUrl: note.content.imageDataUrl,
          pageTitle: note.metadata.pageTitle || '',
          timestamp: note.metadata.createdAt
        });
      }
      return items;
    }
  } catch (e) {}
  const items = [];
  if (note.content.text) items.push({ id: genItemId(), type: 'text', content: note.content.text, timestamp: note.metadata.createdAt });
  if (note.content.imageDataUrl) items.push({ id: genItemId(), type: 'capture', imageDataUrl: note.content.imageDataUrl, pageTitle: note.metadata.pageTitle, timestamp: note.metadata.createdAt });
  return items;
}

function getLocalWorkspaceTitle(note) {
  try {
    const parsed = JSON.parse(note.content.text);
    if (parsed?.__workspace) return parsed.title || note.metadata.pageTitle || '';
  } catch (e) {}
  return note.metadata.pageTitle || '';
}

async function parseObsidianMarkdownToItems(markdown, note) {
  const localItems = parseLocalWorkspaceItems(note);
  const captureByFilename = {};
  localItems.forEach((item, i) => {
    if (item.type === 'capture') {
      // Use the stored imageFilename (written back on push) if available;
      // fall back to index-based name for notes pushed before this fix.
      const filename = item.imageFilename || `${note.id}-${i}.jpg`;
      captureByFilename[filename] = item;
    }
  });

  // Derive the vault folder from the note's googleDocId (e.g. "Folder/Note.md" → "Folder")
  const googleDocId = note.metadata.googleDocId || '';
  const noteFolder = googleDocId.includes('/') ? googleDocId.slice(0, googleDocId.lastIndexOf('/')) : '';

  const titleMatch = markdown.match(/^# (.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Strip heading line and any old *timestamp*\n\n---\n\n metadata header
  let body = markdown.replace(/^# [^\n]*\n\n?/, '').trim();
  const metaStrip = body.match(/^\*[^\n]*\*\n\n---\n\n([\s\S]*)$/);
  if (metaStrip) body = metaStrip[1].trim();
  // Also strip bare ---\n\n separator (from notes that had separator but no timestamp)
  else body = body.replace(/^---\n\n/, '');

  const blocks = splitIntoBlocks(body);

  const items = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Match ![[path/image.jpg]] or ![[image.jpg]] — extract just the basename
    const imgMatch = trimmed.match(/^!\[\[(?:[^\]]*\/)?([^/\]]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg))\]\]$/i);
    if (imgMatch) {
      const filename = imgMatch[1];
      const local = captureByFilename[filename];
      if (local) {
        items.push({ ...local });
      } else {
        // Unknown image (manually inserted in Obsidian) — try to fetch it
        const imageDataUrl = await fetchObsidianImage(noteFolder, filename);
        if (imageDataUrl) {
          items.push({
            id: genItemId(),
            type: 'capture',
            imageDataUrl,
            imageFilename: filename,
            pageTitle: filename,
            timestamp: Date.now()
          });
        }
      }
      continue;
    }

    const lines = trimmed.split('\n');
    if (lines.every(l => /^> ?/.test(l))) {
      items.push({
        id: genItemId(),
        type: 'voice',
        content: lines.map(l => l.replace(/^> ?/, '')).join('\n'),
        timestamp: Date.now()
      });
      continue;
    }

    items.push({ id: genItemId(), type: 'text', content: trimmed, timestamp: Date.now() });
  }

  return { title, items };
}

/** Fetch an image from the Obsidian vault and return a data URL, or null on failure. */
async function fetchObsidianImage(noteFolder, filename) {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const baseUrl = (settings?.obsidianUrl || 'http://localhost:27123').replace(/\/$/, '');
    const apiKey = settings?.obsidianApiKey || '';
    if (!apiKey) return null;

    const candidates = [];
    if (noteFolder) {
      candidates.push(`${noteFolder}/attachments/${filename}`);
      candidates.push(`${noteFolder}/${filename}`);
    }
    candidates.push(`attachments/${filename}`);
    candidates.push(filename);

    for (const vaultPath of candidates) {
      const encoded = vaultPath.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`${baseUrl}/vault/${encoded}`, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
      });
      if (!res.ok) continue;
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      if (dataUrl) return dataUrl;
    }
  } catch (e) {
    console.warn('[fetchObsidianImage] failed for', filename, e);
  }
  return null;
}

function splitIntoBlocks(text) {
  const blocks = [];
  let current = '';
  let inFence = false;

  for (const line of text.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;

    if (!inFence && line.trim() === '' && current.trim()) {
      blocks.push(current);
      current = '';
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) blocks.push(current);
  return blocks;
}

// ===================== FORMAT TOOLBAR (contenteditable) =====================

/**
 * Get the block-level element (direct child of editor-content) containing the cursor.
 */
function getCurrentBlock() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const ce = el.editorContent;
  while (node && node.parentNode !== ce) node = node.parentNode;
  return (node && node !== ce) ? node : null;
}

function applyFormat(fmt) {
  // Save selection before focus() in case it disturbs it (Chrome side-panel quirk)
  const sel = window.getSelection();
  const savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  el.editorContent.focus();
  if (savedRange && sel.rangeCount === 0) sel.addRange(savedRange);
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0).cloneRange();
  const selectedText = range.toString();

  // Line-prefix formats
  const linePrefixMap = {
    h1: '# ', h2: '## ', h3: '### ', h4: '#### ',
    bullet: '- ', numbered: '1. ', quote: '> ', checkbox: '- [ ] '
  };
  if (linePrefixMap[fmt]) {
    const prefix = linePrefixMap[fmt];
    let block = getCurrentBlock();
    // If no block found or block is a capture/drop-indicator, find/create a text block
    if (!block || block.classList?.contains('ce-capture') || block.classList?.contains('ce-drop-line')) {
      const textChildren = [...el.editorContent.children].filter(c =>
        !c.classList.contains('ce-capture') && !c.classList.contains('ce-drop-line')
      );
      block = textChildren[textChildren.length - 1] || null;
      if (!block) {
        block = document.createElement('div');
        el.editorContent.appendChild(block);
      }
    }
    // Use textContent to avoid <br> newline artifacts from innerText
    const rawText = (block.textContent || '').replace(/\n$/, '');
    // Strip any existing heading prefix to support level switching (e.g. H2 → H1)
    const stripped = rawText.replace(/^#{1,6} /, '');
    block.textContent = rawText.startsWith(prefix) ? stripped : prefix + stripped;
    // Place cursor at end
    const r = document.createRange();
    r.selectNodeContents(block);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    if (workspace) setEditorDirty(true);
    return;
  }

  // Inline wrap formats
  const wrapMap = { bold: ['**', '**'], italic: ['*', '*'], code: ['`', '`'], strikethrough: ['~~', '~~'] };
  if (wrapMap[fmt]) {
    const [open, close] = wrapMap[fmt];
    if (selectedText) {
      const node = document.createTextNode(open + selectedText + close);
      range.deleteContents();
      range.insertNode(node);
      const r = document.createRange();
      r.setStartAfter(node);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      const node = document.createTextNode(open + close);
      range.insertNode(node);
      const r = document.createRange();
      r.setStart(node, open.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (workspace) setEditorDirty(true);
    return;
  }

  if (fmt === 'hr') {
    insertTextAtCursor('\n---\n');
    if (workspace) setEditorDirty(true);
    return;
  }

  if (fmt === 'codeblock') {
    if (selectedText) {
      const node = document.createTextNode('```\n' + selectedText + '\n```');
      range.deleteContents();
      range.insertNode(node);
      const r = document.createRange();
      r.setStartAfter(node);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      const node = document.createTextNode('```\n\n```');
      range.insertNode(node);
      const r = document.createRange();
      r.setStart(node, 4); // between ``` and ```
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (workspace) setEditorDirty(true);
  }
}

/**
 * Insert text at the current cursor position in the contenteditable.
 */
function insertTextAtCursor(text) {
  el.editorContent.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) {
    // Append to end
    const div = document.createElement('div');
    div.textContent = text;
    el.editorContent.appendChild(div);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  const r = document.createRange();
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// ===================== EDITOR KEYBOARD HANDLING =====================

function handleEditorKeydown(e) {
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;

  if (e.key === 'Enter' && !e.shiftKey) {
    const block = getCurrentBlock();
    if (!block || block.classList?.contains('ce-capture')) return;

    const text = block.innerText || '';
    const bulletMatch = text.match(/^(\s*)([-*+]) /);
    const numberedMatch = text.match(/^(\s*)(\d+)\. /);
    const quoteMatch = text.match(/^(> )+/);
    const headingMatch = text.match(/^#{1,6} /);

    if (bulletMatch || numberedMatch || quoteMatch || headingMatch) {
      e.preventDefault();

      if (headingMatch) {
        // After heading: next line has no prefix
        const newBlock = document.createElement('div');
        newBlock.innerHTML = '<br>';
        block.after(newBlock);
        moveCursorToBlock(newBlock);
        return;
      }

      let prefix = '';
      let lineContent = '';
      if (bulletMatch) {
        prefix = bulletMatch[1] + bulletMatch[2] + ' ';
        lineContent = text.substring(prefix.length);
      } else if (numberedMatch) {
        prefix = numberedMatch[1] + (parseInt(numberedMatch[2]) + 1) + '. ';
        lineContent = text.substring(numberedMatch[0].length);
      } else if (quoteMatch) {
        prefix = quoteMatch[0];
        lineContent = text.substring(prefix.length);
      }

      if (!lineContent.trim()) {
        // Empty list item → exit list
        block.textContent = '';
        block.innerHTML = '<br>';
        moveCursorToBlock(block);
      } else {
        const newBlock = document.createElement('div');
        newBlock.textContent = prefix;
        block.after(newBlock);
        moveCursorToBlock(newBlock, 'end');
      }
    }
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const block = getCurrentBlock();
    if (!block || block.classList?.contains('ce-capture')) return;
    const text = block.innerText || '';
    const isList = /^(\s*)([-*+]|\d+\.) /.test(text);
    if (isList) {
      if (e.shiftKey && text.startsWith('  ')) {
        block.textContent = text.substring(2);
      } else if (!e.shiftKey) {
        block.textContent = '  ' + text;
      }
    } else {
      insertTextAtCursor('  ');
    }
    moveCursorToBlock(block, 'end');
  }
}

function moveCursorToBlock(block, position = 'end') {
  const r = document.createRange();
  if (position === 'end') {
    r.selectNodeContents(block);
    r.collapse(false);
  } else {
    r.setStart(block, 0);
    r.collapse(true);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// ===================== SAVE / DISCARD =====================

async function saveWorkspace() {
  if (!workspace) return;
  try {
    showLoading(true);

    // Snapshot noteId immediately — workspace can be mutated by concurrent user
    // actions (e.g. clicking ✏️) during the awaits below.
    const noteId = workspace.noteId;
    const title = el.editorTitle.value.trim() || 'Untitled';
    workspace.title = title;

    const itemsToSave = serializeEditorToItems();
    const firstCapture = itemsToSave.find(i => i.type === 'capture');
    const pageUrl = firstCapture?.pageUrl || '';
    const serialized = JSON.stringify({ __workspace: true, title, items: itemsToSave });

    let result;
    if (noteId) {
      result = await messageBus.sendToBackground(MessageTypes.UPDATE_NOTE, {
        id: noteId,
        updates: {
          content: { text: serialized, imageDataUrl: firstCapture?.imageDataUrl || null },
          metadata: { pageTitle: title, pageUrl }
        }
      });
    } else {
      result = await messageBus.sendToBackground(MessageTypes.CREATE_NOTE, {
        type: 'manual',
        text: serialized,
        ocrText: '',
        imageDataUrl: firstCapture?.imageDataUrl || null,
        pageTitle: title,
        pageUrl,
        videoUrl: '',
        videoTimestamp: '0:00'
      });
    }

    if (!result) throw new Error('No response from background');
    if (!result.success) throw new Error(result.error || 'Save failed');

    // For a new note, record the assigned ID so the next save does UPDATE not CREATE
    if (!noteId && result.note?.id) {
      workspace.noteId = result.note.id;
    }

    // Push to Obsidian if connected and online
    const state = store.getState();
    const isAuthenticated = !!(state.auth?.token && state.auth.expiresAt > Date.now());
    if (isAuthenticated && state.isOnline && workspace.noteId) {
      const pushResult = await messageBus.sendToBackground(MessageTypes.PUSH_NOTE, { noteId: workspace.noteId });
      if (pushResult?.success) {
        showToast('Saved & pushed to Obsidian', 'success');
      } else {
        showToast('Saved (push failed: ' + (pushResult?.error || 'unknown') + ')', 'warning');
      }
    } else {
      showToast('Note saved', 'success');
    }

    setEditorDirty(false);
    // Stay in editor — do not switch to list
  } catch (error) {
    console.error('[saveWorkspace]', error);
    showToast('Save failed: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

function discardWorkspace() {
  workspace = null;
  setEditorDirty(false);
  switchTab('list');
}

// ===================== DIRTY STATE =====================

/**
 * Toggle the "unsaved changes" dot superscript on the Save Note button.
 */
function setEditorDirty(dirty) {
  editorDirty = dirty;
  el.btnSaveNote.classList.toggle('dirty', dirty);
}

// ===================== CAPTURE =====================

async function handleCapture() {
  if (!workspace) {
    workspace = { noteId: null, title: '', captureItems: {} };
    el.editorTitle.value = '';
    el.editorContent.innerHTML = '';
    switchTab('editor');
  }

  try {
    showLoading(true);
    const result = await messageBus.sendToBackground(MessageTypes.CAPTURE_FRAME, {});
    if (!result.success) throw new Error(result.error || 'Capture failed');

    const captureItem = {
      id: genItemId(),
      type: 'capture',
      imageDataUrl: result.imageDataUrl,
      pageTitle: result.pageTitle,
      pageUrl: result.pageUrl,
      timestamp: result.timestamp
    };

    workspace.captureItems[captureItem.id] = captureItem;

    // Insert at cursor, or append if no focus
    const ce = el.editorContent;
    ce.focus();
    const block = createCaptureBlock(captureItem);
    const spacer = document.createElement('div');
    spacer.innerHTML = '<br>';

    const sel = window.getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      // Find insertion point as a direct child of ce
      let anchor = range.startContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      while (anchor && anchor.parentNode !== ce) anchor = anchor.parentNode;

      if (anchor && anchor !== ce) {
        anchor.after(block);
        block.after(spacer);
      } else {
        ce.appendChild(block);
        ce.appendChild(spacer);
      }
    } else {
      ce.appendChild(block);
      ce.appendChild(spacer);
    }

    moveCursorToBlock(spacer);
    showToast('Screenshot captured', 'success');
  } catch (error) {
    showToast('Capture failed: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ===================== VOICE =====================

async function handleVoice() {
  if (!isSpeechRecognitionSupported()) {
    el.voiceNotSupported.style.display = 'block';
    el.voiceRecord.disabled = true;
  } else {
    el.voiceNotSupported.style.display = 'none';
    el.voiceRecord.disabled = false;
  }
  resetVoiceModal();
  try {
    const settings = await chrome.storage.local.get('settings');
    el.voiceLanguage.value = settings.settings?.voiceLanguage || 'en-US';
  } catch (e) {}
  el.voiceModal.style.display = 'flex';
}

function resetVoiceModal() {
  el.voiceFinalTranscript.textContent = '';
  el.voiceInterimTranscript.textContent = '';
  el.voiceStatusText.textContent = 'Click the microphone to start recording';
  el.voiceIndicator.classList.remove('recording', 'listening');
  el.voiceRecord.classList.remove('recording');
  el.voiceRecordIcon.textContent = '🎤';
  el.voiceRecordText.textContent = 'Start Recording';
  el.voiceSave.style.display = 'none';
  el.voiceRecord.style.display = 'inline-flex';
  if (speechRecognizer && speechRecognizer.isActive()) speechRecognizer.stop();
}

function closeVoiceModal() {
  if (speechRecognizer && speechRecognizer.isActive()) speechRecognizer.stop();
  el.voiceModal.style.display = 'none';
  resetVoiceModal();
}

async function handleVoiceRecord() {
  if (!speechRecognizer) {
    speechRecognizer = createSpeechRecognizer({
      language: el.voiceLanguage.value,
      continuous: true,
      interimResults: true
    });
    speechRecognizer.onStart = () => {
      el.voiceIndicator.classList.add('recording');
      el.voiceRecord.classList.add('recording');
      el.voiceRecordIcon.textContent = '⏹️';
      el.voiceRecordText.textContent = 'Stop Recording';
      el.voiceStatusText.textContent = 'Listening… Speak now';
    };
    speechRecognizer.onEnd = (result) => {
      el.voiceIndicator.classList.remove('recording', 'listening');
      el.voiceRecord.classList.remove('recording');
      el.voiceRecordIcon.textContent = '🎤';
      el.voiceRecordText.textContent = 'Start Recording';
      const transcript = result.finalTranscript.trim();
      if (transcript) {
        el.voiceStatusText.textContent = 'Done! Click "Add to Note" to save.';
        el.voiceSave.style.display = 'inline-flex';
        el.voiceRecord.style.display = 'none';
      } else {
        el.voiceStatusText.textContent = 'No speech detected. Try again.';
      }
    };
    speechRecognizer.onResult = (result) => {
      el.voiceFinalTranscript.textContent = result.fullTranscript;
      el.voiceIndicator.classList.add('listening');
      el.voiceIndicator.classList.remove('recording');
    };
    speechRecognizer.onInterimResult = (result) => {
      el.voiceInterimTranscript.textContent = result.transcript;
    };
    speechRecognizer.onError = (error) => {
      showToast('Voice error: ' + error.message, 'error');
      el.voiceIndicator.classList.remove('recording', 'listening');
      el.voiceRecord.classList.remove('recording');
      el.voiceRecordIcon.textContent = '🎤';
      el.voiceRecordText.textContent = 'Start Recording';
      el.voiceStatusText.textContent = error.message;
    };
  }

  if (speechRecognizer.isActive()) {
    speechRecognizer.stop();
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      speechRecognizer.start();
    } catch (error) {
      const msg = error.name === 'NotAllowedError' ? 'Microphone permission denied.' : 'Failed to start: ' + error.message;
      showToast(msg, 'error');
      el.voiceStatusText.textContent = msg;
    }
  }
}

function handleSaveVoice() {
  const transcript = speechRecognizer ? speechRecognizer.getTranscript().final.trim() : '';
  if (!transcript) {
    showToast('No voice transcript', 'warning');
    return;
  }

  if (!workspace) {
    workspace = { noteId: null, title: '', captureItems: {} };
    el.editorTitle.value = '';
    el.editorContent.innerHTML = '';
    switchTab('editor');
  }

  // Insert voice as blockquote text at cursor (or end)
  const voiceText = transcript.split('\n').map(l => '> ' + l).join('\n');
  el.editorContent.focus();

  // Append as new div(s) at end, first removing trailing empty/spacer divs
  const ce = el.editorContent;
  while (ce.lastChild && ce.lastChild.nodeName === 'DIV' &&
         (ce.lastChild.innerHTML === '<br>' || !ce.lastChild.textContent.trim())) {
    ce.removeChild(ce.lastChild);
  }
  const lines = voiceText.split('\n');
  lines.forEach(line => {
    const div = document.createElement('div');
    div.textContent = line;
    ce.appendChild(div);
  });
  // Scroll to bottom
  ce.scrollTop = ce.scrollHeight;

  if (workspace) setEditorDirty(true);
  closeVoiceModal();
  showToast('Voice added to note', 'success');
}

// ===================== NOTES LIST =====================

function renderNotes(notes) {
  const filtered = filterNotes(notes);
  el.notesContainer.innerHTML = '';

  if (filtered.length === 0) {
    el.emptyState.style.display = 'block';
    el.notesContainer.appendChild(el.emptyState);
    return;
  }

  el.emptyState.style.display = 'none';
  filtered.forEach(note => el.notesContainer.appendChild(createFileItem(note)));
}

function filterNotes(notes) {
  return notes.filter(note => {
    if (filterType === 'pending' && note.metadata.syncStatus !== 'pending') return false;
    if (filterType === 'synced' && note.metadata.syncStatus !== 'synced') return false;
    if (filterType === 'withImages' && !note.content.imageDataUrl) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const haystack = [note.metadata.pageTitle, note.content.text].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Obsidian-style minimal file-explorer entry.
 */
function createFileItem(note) {
  const title = getLocalWorkspaceTitle(note) || 'Untitled';
  let hasCapture = !!note.content.imageDataUrl;

  try {
    const parsed = JSON.parse(note.content.text);
    if (parsed?.__workspace) {
      hasCapture = hasCapture || (parsed.items || []).some(i => i.type === 'capture');
    }
  } catch (e) {}

  const item = document.createElement('div');
  item.className = 'file-item';

  const icon = document.createElement('span');
  icon.className = 'file-item-icon';
  icon.textContent = hasCapture ? '📸' : '📝';

  const body = document.createElement('div');
  body.className = 'file-item-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'file-item-title';
  titleEl.textContent = title;

  const meta = document.createElement('div');
  meta.className = 'file-item-meta';
  meta.textContent = formatDate(note.metadata.createdAt);

  body.appendChild(titleEl);
  body.appendChild(meta);

  const right = document.createElement('div');
  right.className = 'file-item-right';

  const dot = document.createElement('span');
  dot.className = `sync-dot ${note.metadata.syncStatus || 'pending'}`;
  dot.title = note.metadata.syncStatus || 'pending';

  // Open-in-Obsidian link
  if (note.metadata.googleDocId && note.metadata.googleDocId.endsWith('.md')) {
    const openBtn = document.createElement('span');
    openBtn.textContent = '↗';
    openBtn.title = 'Open in Obsidian';
    openBtn.style.cssText = 'cursor:pointer;color:var(--primary-color);font-size:13px;';
    openBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await messageBus.sendToBackground(MessageTypes.GET_SETTINGS);
        const vaultName = r.success && r.settings?.obsidianVaultName;
        if (vaultName) {
          window.open(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(note.metadata.googleDocId)}`, '_blank');
        } else {
          showToast('Set your vault name in Obsidian config first', 'warning');
        }
      } catch (e) { showToast('Could not open in Obsidian', 'error'); }
    });
    right.appendChild(openBtn);
  }

  right.appendChild(dot);

  const delBtn = document.createElement('button');
  delBtn.className = 'file-item-delete';
  delBtn.textContent = '🗑';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); confirmDeleteNote(note.id); });

  right.appendChild(delBtn);

  item.appendChild(icon);
  item.appendChild(body);
  item.appendChild(right);

  item.addEventListener('click', () => openNoteInEditor(note));
  return item;
}

// ===================== NOTE ACTIONS =====================

async function confirmDeleteNote(noteId) {
  if (!confirm('Delete this note?')) return;
  try {
    showLoading(true);
    const result = await messageBus.sendToBackground(MessageTypes.DELETE_NOTE, { id: noteId });
    if (result.success) {
      showToast('Note deleted', 'success');
      // If the deleted note is currently open in the editor, disable it
      if (workspace?.noteId === noteId) {
        workspace = null;
        showEditorDeletedState(true);
      }
    } else {
      showToast('Delete failed: ' + result.error, 'error');
    }
  } catch (error) {
    showToast('Delete failed', 'error');
  } finally {
    showLoading(false);
  }
}

// ===================== AUTH / SYNC / DOCS =====================

async function handleAuth() {
  const state = store.getState();
  const isAuthenticated = state.auth && state.auth.token && state.auth.expiresAt > Date.now();
  if (isAuthenticated) {
    if (!confirm('Disconnect from Obsidian?')) return;
    try {
      showLoading(true);
      const result = await messageBus.sendToBackground(MessageTypes.LOGOUT);
      if (result.success) showToast('Disconnected from Obsidian', 'success');
      else throw new Error(result.error);
    } catch (error) {
      showToast('Disconnect failed: ' + error.message, 'error');
    } finally {
      showLoading(false);
    }
  } else {
    openObsidianConfigModal();
  }
}

function openObsidianConfigModal() {
  const modal = document.getElementById('obsidian-config-modal');
  if (!modal) return;
  chrome.storage.local.get('settings').then(({ settings }) => {
    const isConfigured = !!settings?.obsidianApiKey;
    document.getElementById('obsidian-vault-input').value = settings?.obsidianVaultName || '';
    document.getElementById('obsidian-url-input').value = settings?.obsidianUrl || 'http://localhost:27123';
    document.getElementById('obsidian-key-input').value = settings?.obsidianApiKey || '';
    showObsidianStep(isConfigured ? 2 : 1);
  });
  modal.style.display = 'flex';
}

function showObsidianStep(step) {
  const isStep1 = step === 1;
  document.getElementById('obsidian-step-1').style.display = isStep1 ? 'block' : 'none';
  document.getElementById('obsidian-footer-1').style.display = isStep1 ? 'flex' : 'none';
  document.getElementById('obsidian-step-2').style.display = isStep1 ? 'none' : 'block';
  document.getElementById('obsidian-footer-2').style.display = isStep1 ? 'none' : 'flex';
  document.getElementById('obsidian-step-indicator').textContent = `Step ${step} of 2`;
  document.getElementById('obsidian-modal-title').textContent = isStep1 ? 'Connect to Obsidian' : 'Enter API Details';
  const result = document.getElementById('obsidian-test-result');
  result.style.display = 'none';
  result.className = 'connection-result';
  result.textContent = '';
}

function closeObsidianConfigModal() {
  const modal = document.getElementById('obsidian-config-modal');
  if (modal) modal.style.display = 'none';
}

async function handleTestObsidianConnection() {
  const url = document.getElementById('obsidian-url-input').value.trim();
  const apiKey = document.getElementById('obsidian-key-input').value.trim();
  const resultEl = document.getElementById('obsidian-test-result');

  if (!apiKey) {
    resultEl.textContent = '⚠️ Please enter an API key first.';
    resultEl.className = 'connection-result warn';
    resultEl.style.display = 'block';
    return;
  }

  resultEl.textContent = 'Testing connection…';
  resultEl.className = 'connection-result info';
  resultEl.style.display = 'block';

  try {
    const testResult = await messageBus.sendToBackground(MessageTypes.REQUEST_AUTH, {
      url, apiKey, vaultName: document.getElementById('obsidian-vault-input').value.trim()
    });
    if (testResult.success) {
      resultEl.textContent = '✅ Connected! Obsidian is running and the plugin is working.';
      resultEl.className = 'connection-result success';
    } else {
      resultEl.textContent = `❌ ${testResult.error || 'Could not connect. Make sure Obsidian is open and the plugin is enabled.'}`;
      resultEl.className = 'connection-result error';
    }
  } catch (e) {
    resultEl.textContent = '❌ Connection failed: ' + e.message;
    resultEl.className = 'connection-result error';
  }
}

async function handleSaveObsidianConfig() {
  const vaultName = document.getElementById('obsidian-vault-input').value.trim();
  const url = document.getElementById('obsidian-url-input').value.trim();
  const apiKey = document.getElementById('obsidian-key-input').value.trim();
  if (!apiKey) { showToast('Please enter an API key', 'warning'); return; }
  try {
    showLoading(true);
    const result = await messageBus.sendToBackground(MessageTypes.REQUEST_AUTH, { url, apiKey, vaultName });
    if (result.success) {
      showToast('Connected to Obsidian', 'success');
      closeObsidianConfigModal();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Connection failed: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleSync() {
  try {
    showLoading(true);

    // Force-pull from Obsidian (Obsidian is source of truth — overwrites local pending edits)
    const result = await messageBus.sendToBackground(MessageTypes.PULL_FROM_OBSIDIAN, { force: true });

    // Refresh notes list from storage (pull already updated it)
    const data = await chrome.storage.local.get('notes');
    const notes = data.notes || {};
    const notesArray = Object.values(notes).sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
    renderNotes(notesArray);

    // If a note is currently open in the editor, reload it from the updated storage
    if (workspace?.noteId) {
      const updatedNote = notes[workspace.noteId];
      if (updatedNote) {
        const items = parseLocalWorkspaceItems(updatedNote);
        const title = getLocalWorkspaceTitle(updatedNote);
        workspace.title = title;
        el.editorTitle.value = title;
        renderItemsInEditor(items);
      } else {
        // Note was removed on the Obsidian side
        workspace = null;
        showEditorDeletedState(true);
      }
    }

    const parts = [];
    if (result?.imported > 0) parts.push(`imported ${result.imported}`);
    if (result?.updated > 0) parts.push(`updated ${result.updated}`);
    showToast(parts.length ? `Synced: ${parts.join(', ')}` : 'Up to date', 'success');
  } catch (error) {
    showToast('Sync failed: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function loadTargetDocumentInfo() {
  try {
    const result = await messageBus.sendToBackground(MessageTypes.GET_SETTINGS);
    const folderPath = result.success && (result.settings?.targetFolderId || result.settings?.targetDocId);
    if (folderPath) {
      el.docName.textContent = folderPath;
    } else {
      el.docName.textContent = 'No folder';
    }
  } catch (e) {}
}

async function openDocumentModal() {
  try {
    const result = await messageBus.sendToBackground(MessageTypes.GET_SETTINGS);
    const current = result.success && (result.settings?.targetFolderId || result.settings?.targetDocId);
    el.newDocTitle.value = current || '';
  } catch (e) {}
  el.docList.innerHTML = '';
  el.docListEmpty.style.display = 'none';
  el.docListLoading.style.display = 'block';
  el.docModal.style.display = 'flex';

  try {
    const result = await Promise.race([
      messageBus.sendToBackground(MessageTypes.LIST_DOCUMENTS, {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
    ]);
    el.docListLoading.style.display = 'none';
    if (result.success && result.folders && result.folders.length > 0) {
      result.folders.forEach(folder => {
        const item = document.createElement('div');
        item.className = 'doc-item';
        item.textContent = '📁 ' + folder;
        item.addEventListener('click', () => { el.newDocTitle.value = folder; });
        el.docList.appendChild(item);
      });
    } else {
      el.docListEmpty.style.display = 'block';
    }
  } catch (error) {
    el.docListLoading.style.display = 'none';
    el.docListEmpty.textContent = 'Could not load folders — make sure Obsidian is running.';
    el.docListEmpty.style.display = 'block';
  }
}

function closeDocumentModal() {
  el.docModal.style.display = 'none';
}

async function handleCreateDocument() {
  const folderPath = el.newDocTitle.value.trim();
  if (!folderPath) { showToast('Enter a vault folder path', 'warning'); return; }
  try {
    showLoading(true);
    const result = await messageBus.sendToBackground(MessageTypes.SET_TARGET_DOCUMENT, {
      documentId: folderPath,
      folderName: folderPath
    });
    if (result.success) {
      showToast(`Vault folder set: ${folderPath}`, 'success');
      closeDocumentModal();
      await loadTargetDocumentInfo();
    } else throw new Error(result.error);
  } catch (error) {
    showToast('Failed: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ===================== UTILS =====================

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showLoading(show) {
  el.loading.style.display = show ? 'flex' : 'none';
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const diff = Date.now() - date;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString();
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// Start
init();
