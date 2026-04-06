/**
 * Google API Client - Wrapper for Google Docs and Drive APIs
 * Handles document creation, content appending, and image uploads
 */

import { logger } from '../modules/utils/logger.js';
import { authManager } from './auth-manager.js';

const log = logger.child('GoogleAPIClient');

// API endpoints
const DOCS_API_BASE = 'https://docs.googleapis.com/v1';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

class GoogleAPIClient {
  constructor() {
    this.rateLimitDelay = 100; // Minimum delay between requests (ms)
    this.lastRequestTime = 0;
  }

  /**
   * Get valid auth token
   */
  async getToken() {
    const result = await authManager.getValidToken();
    if (!result.success || !result.token) {
      throw new Error('Not authenticated');
    }
    return result.token;
  }

  /**
   * Rate limit requests to avoid hitting API limits
   */
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.rateLimitDelay) {
      const delay = this.rateLimitDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Create a new Google Doc
   */
  async createDocument(title) {
    try {
      await this.rateLimit();
      const token = await this.getToken();

      log.info('Creating Google Doc:', title);

      const response = await fetch(`${DOCS_API_BASE}/documents`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: title
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to create document: ${error.error?.message || response.statusText}`);
      }

      const doc = await response.json();

      log.info('Document created:', {
        documentId: doc.documentId,
        title: doc.title
      });

      return {
        success: true,
        documentId: doc.documentId,
        title: doc.title,
        url: `https://docs.google.com/document/d/${doc.documentId}/edit`
      };

    } catch (error) {
      log.error('Failed to create document', error);
      throw error;
    }
  }

  /**
   * Get document content and metadata
   */
  async getDocument(documentId) {
    try {
      await this.rateLimit();
      const token = await this.getToken();

      log.debug('Getting document:', documentId);

      const response = await fetch(
        `${DOCS_API_BASE}/documents/${documentId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to get document: ${error.error?.message || response.statusText}`);
      }

      const doc = await response.json();

      // Calculate document length (end index of last element)
      const endIndex = doc.body.content[doc.body.content.length - 1].endIndex - 1;

      return {
        success: true,
        documentId: doc.documentId,
        title: doc.title,
        endIndex: endIndex,
        revisionId: doc.revisionId,
        body: doc.body  // Include full body for parsing
      };

    } catch (error) {
      log.error('Failed to get document', error);
      throw error;
    }
  }

  /**
   * Read and parse notes from a Google Doc
   * Extracts notes that were synced to the document
   */
  async readNotesFromDocument(documentId) {
    try {
      log.info('Reading notes from document:', documentId);

      const doc = await this.getDocument(documentId);

      if (!doc.success || !doc.body) {
        throw new Error('Failed to get document content');
      }

      // Extract all text from document
      let fullText = '';
      for (const element of doc.body.content) {
        if (element.paragraph && element.paragraph.elements) {
          for (const textElement of element.paragraph.elements) {
            if (textElement.textRun && textElement.textRun.content) {
              fullText += textElement.textRun.content;
            }
          }
        }
      }

      log.debug('Document text length:', fullText.length);

      // Parse notes from the text
      const notes = this.parseNotesFromText(fullText, documentId);

      log.info(`Parsed ${notes.length} notes from document`);

      return {
        success: true,
        notes: notes,
        documentTitle: doc.title
      };

    } catch (error) {
      log.error('Failed to read notes from document', error);
      throw error;
    }
  }

  /**
   * Parse formatted notes from document text
   * Looks for our specific formatting pattern
   */
  parseNotesFromText(text, documentId) {
    const notes = [];

    // Split by separator line (50 dashes)
    const separator = '─'.repeat(50);
    const sections = text.split(separator);

    // Skip first section (before first note) and process the rest
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i].trim();
      if (!section) continue;

      try {
        const note = this.parseNoteSection(section, documentId, i);
        if (note) {
          notes.push(note);
        }
      } catch (error) {
        log.warn('Failed to parse note section', error);
        // Continue parsing other notes
      }
    }

    return notes;
  }

  /**
   * Parse a single note section
   */
  parseNoteSection(sectionText, documentId, index) {
    const lines = sectionText.split('\n').filter(line => line.trim());

    if (lines.length === 0) return null;

    // Parse header line (e.g., "📝 Capture Note - 3/13/2026, 10:30:45 AM")
    const headerLine = lines[0];
    let noteType = 'manual';
    let timestamp = null;

    if (headerLine.includes('Capture Note')) {
      noteType = 'capture';
    } else if (headerLine.includes('Voice Note')) {
      noteType = 'voice';
    } else if (headerLine.includes('Manual Note')) {
      noteType = 'manual';
    }

    // Extract timestamp from header
    const dateMatch = headerLine.match(/(\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)/);
    if (dateMatch) {
      timestamp = new Date(dateMatch[1]).getTime();
    }

    // Parse content sections
    let pageTitle = '';
    let videoUrl = '';
    let videoTimestamp = '';
    let ocrText = '';
    let noteText = '';

    let currentSection = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Detect sections
      if (line.startsWith('📄 ')) {
        pageTitle = line.substring(2).trim();
      } else if (line.startsWith('🔗 ')) {
        const urlLine = line.substring(2).trim();
        const urlMatch = urlLine.match(/^(https?:\/\/[^\s]+)(?:\s+\(([^)]+)\))?/);
        if (urlMatch) {
          videoUrl = urlMatch[1];
          videoTimestamp = urlMatch[2] || '0:00';
        }
      } else if (line.startsWith('🔍 OCR Extracted Text:')) {
        currentSection = 'ocr';
      } else if (line.startsWith('📋 Notes:')) {
        currentSection = 'notes';
      } else {
        // Add to current section
        if (currentSection === 'ocr') {
          ocrText += line + '\n';
        } else if (currentSection === 'notes') {
          noteText += line + '\n';
        }
      }
    }

    // Create note object
    return {
      id: `doc-note-${documentId}-${index}`,
      type: noteType,
      content: {
        text: noteText.trim(),
        ocrText: ocrText.trim(),
        imageDataUrl: null,  // Images in doc, not stored
        videoUrl: videoUrl,
        timestamp: videoTimestamp
      },
      metadata: {
        pageTitle: pageTitle,
        pageUrl: videoUrl,
        createdAt: timestamp || Date.now(),
        updatedAt: timestamp || Date.now(),
        syncStatus: 'synced',
        syncedToDocId: documentId,
        fromDocument: true  // Mark as read from document
      }
    };
  }

  /**
   * Upload image to Google Drive
   */
  async uploadImage(dataUrl, filename = 'note-image.jpg') {
    try {
      await this.rateLimit();
      const token = await this.getToken();

      log.info('Uploading image to Drive:', filename);

      // Convert data URL to blob
      const blob = await this.dataUrlToBlob(dataUrl);

      // Create multipart upload
      const metadata = {
        name: filename,
        mimeType: 'image/jpeg'
      };

      const formData = new FormData();
      formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      formData.append('file', blob);

      const response = await fetch(
        `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: formData
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to upload image: ${error.error?.message || response.statusText}`);
      }

      const file = await response.json();

      // Make file publicly accessible (required for embedding in Docs)
      await this.makeFilePublic(file.id);

      log.info('Image uploaded:', {
        fileId: file.id,
        name: file.name
      });

      return {
        success: true,
        fileId: file.id,
        name: file.name,
        url: `https://drive.google.com/uc?id=${file.id}`
      };

    } catch (error) {
      log.error('Failed to upload image', error);
      throw error;
    }
  }

  /**
   * Make a Drive file publicly accessible
   */
  async makeFilePublic(fileId) {
    try {
      await this.rateLimit();
      const token = await this.getToken();

      const response = await fetch(
        `${DRIVE_API_BASE}/files/${fileId}/permissions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            role: 'reader',
            type: 'anyone'
          })
        }
      );

      if (!response.ok) {
        log.warn('Failed to make file public (non-fatal)');
      }

    } catch (error) {
      log.warn('Failed to make file public', error);
      // Non-fatal, continue anyway
    }
  }

  /**
   * Append content to a Google Doc using batchUpdate
   */
  async appendToDocument(documentId, requests) {
    try {
      await this.rateLimit();
      const token = await this.getToken();

      log.info('Appending to document:', {
        documentId,
        requestCount: requests.length
      });

      const response = await fetch(
        `${DOCS_API_BASE}/documents/${documentId}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            requests: requests
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to append to document: ${error.error?.message || response.statusText}`);
      }

      const result = await response.json();

      log.info('Content appended successfully');

      return {
        success: true,
        documentId: documentId,
        replies: result.replies
      };

    } catch (error) {
      log.error('Failed to append to document', error);
      throw error;
    }
  }

  /**
   * Format and append a note to Google Doc.
   * Workspace notes create their own file; legacy notes append to the target doc.
   */
  async appendNote(documentId, note, folderId = null) {
    try {
      // Detect workspace notes
      let workspaceData = null;
      try {
        const parsed = JSON.parse(note.content.text);
        if (parsed && parsed.__workspace) workspaceData = parsed;
      } catch (e) {}

      if (workspaceData) {
        return await this.appendWorkspaceNote(note, workspaceData, folderId);
      }

      // ── Legacy note: append to the shared target document ──
      log.info('Formatting legacy note for Google Docs:', note.id);

      const doc = await this.getDocument(documentId);
      let insertIndex = doc.endIndex;
      const requests = [];

      const header = this.formatNoteHeader(note);
      requests.push({ insertText: { text: header, location: { index: insertIndex } } });
      insertIndex += header.length;

      if (note.content.imageDataUrl) {
        const imageResult = await this.uploadImage(note.content.imageDataUrl, `note-${note.id}.jpg`);
        requests.push({ insertInlineImage: { uri: imageResult.url, location: { index: insertIndex } } });
        insertIndex += 1;
        requests.push({ insertText: { text: '\n', location: { index: insertIndex } } });
        insertIndex += 1;
      }

      if (note.content.ocrText && note.content.ocrText.trim()) {
        const s = this.formatOCRText(note.content.ocrText);
        requests.push({ insertText: { text: s, location: { index: insertIndex } } });
        insertIndex += s.length;
      }

      if (note.content.text && note.content.text.trim()) {
        const s = this.formatUserNotes(note.content.text);
        requests.push({ insertText: { text: s, location: { index: insertIndex } } });
        insertIndex += s.length;
      }

      requests.push({ insertText: { text: '\n', location: { index: insertIndex } } });
      await this.appendToDocument(documentId, requests);

      return { success: true, documentId, noteId: note.id };

    } catch (error) {
      log.error('Failed to append note', error);
      throw error;
    }
  }

  /**
   * Save a workspace note as its own Google Doc.
   * Title → Heading 1, then each item (text/voice as paragraph, capture as inline image).
   */
  async appendWorkspaceNote(note, workspaceData, folderId = null) {
    const title = workspaceData.title || note.metadata.pageTitle || 'Untitled Note';

    let documentId = note.metadata.googleDocId || null;

    if (documentId) {
      // Update existing doc: wipe content and rewrite
      log.info('Updating existing Google Doc for workspace note:', documentId);
      const existing = await this.getDocument(documentId);
      if (existing.endIndex > 1) {
        await this.appendToDocument(documentId, [{
          deleteContentRange: { range: { startIndex: 1, endIndex: existing.endIndex } }
        }]);
      }
    } else {
      // Create a new document inside the target folder
      log.info('Creating Google Doc in folder for workspace note:', title);
      documentId = await this.createDocumentInFolder(title, folderId);
    }

    // Insert title as Heading 1
    const fresh = await this.getDocument(documentId);
    let idx = fresh.endIndex;

    await this.appendToDocument(documentId, [
      { insertText: { text: title + '\n', location: { index: idx } } },
      {
        updateParagraphStyle: {
          range: { startIndex: idx, endIndex: idx + title.length + 1 },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType'
        }
      }
    ]);

    // Insert each workspace item in order
    for (const item of (workspaceData.items || [])) {
      const current = await this.getDocument(documentId);
      idx = current.endIndex;

      if (item.type === 'text' || item.type === 'voice') {
        const text = (item.content || '').trim();
        if (!text) continue;
        await this.appendToDocument(documentId, [
          { insertText: { text: text + '\n', location: { index: idx } } }
        ]);

      } else if (item.type === 'capture' && item.imageDataUrl) {
        const imageResult = await this.uploadImage(item.imageDataUrl, `screenshot-${Date.now()}.jpg`);

        await this.appendToDocument(documentId, [
          { insertInlineImage: { uri: imageResult.url, location: { index: idx } } }
        ]);

        const after = await this.getDocument(documentId);
        await this.appendToDocument(documentId, [
          { insertText: { text: '\n', location: { index: after.endIndex } } }
        ]);
      }
    }

    log.info('Workspace note saved as new doc:', documentId);
    return { success: true, documentId, noteId: note.id };
  }

  /**
   * Format note header with metadata
   */
  formatNoteHeader(note) {
    const date = new Date(note.metadata.createdAt).toLocaleString();
    const noteType = note.type.charAt(0).toUpperCase() + note.type.slice(1);

    let header = `📝 ${noteType} Note - ${date}\n`;

    if (note.metadata.pageTitle) {
      header += `📄 ${note.metadata.pageTitle}\n`;
    }

    if (note.content.videoUrl) {
      header += `🔗 ${note.content.videoUrl}`;
      if (note.content.timestamp && note.content.timestamp !== '0:00') {
        header += ` (${note.content.timestamp})`;
      }
      header += '\n';
    }

    header += '\n';

    return header;
  }

  /**
   * Format OCR text section
   */
  formatOCRText(ocrText) {
    return `🔍 OCR Extracted Text:\n${ocrText.trim()}\n\n`;
  }

  /**
   * Format user notes section
   */
  formatUserNotes(text) {
    return `📋 Notes:\n${text.trim()}\n\n`;
  }

  /**
   * Convert data URL to Blob
   */
  async dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return await response.blob();
  }

  /**
   * Delete a note from Google Doc (future implementation)
   */
  async deleteNoteFromDocument(documentId, notePosition, noteLength) {
    // This would require tracking note positions in the document
    // Complex to implement - would need to store character positions
    // For now, notes remain in doc even if deleted from extension
    log.warn('Delete from document not yet implemented');
    return { success: false, reason: 'not_implemented' };
  }

  /**
   * List user's Google Docs
   */
  async listDocuments(maxResults = 10) {
    try {
      log.info('Starting listDocuments request');

      await this.rateLimit();
      log.debug('Rate limit passed');

      const token = await this.getToken();
      log.debug('Got token:', token ? 'EXISTS' : 'MISSING');

      const query = "mimeType='application/vnd.google-apps.folder' and trashed=false";
      const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&pageSize=${maxResults}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`;

      log.info('Fetching from Drive API:', url);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      log.info('Drive API response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        log.error('Drive API error response:', errorText);

        let errorMessage = response.statusText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || response.statusText;
        } catch (e) {
          errorMessage = errorText;
        }

        throw new Error(`Failed to list documents (${response.status}): ${errorMessage}`);
      }

      const result = await response.json();
      log.info('Documents found:', result.files?.length || 0);

      return {
        success: true,
        documents: result.files || []
      };

    } catch (error) {
      log.error('Failed to list documents', error);
      log.error('Error stack:', error.stack);
      throw error;
    }
  }
  /**
   * Create a Google Drive folder
   */
  async createFolder(name) {
    await this.rateLimit();
    const token = await this.getToken();
    const response = await fetch(`${DRIVE_API_BASE}/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Failed to create folder');
    }
    const folder = await response.json();
    return {
      success: true,
      folderId: folder.id,
      name: folder.name,
      url: `https://drive.google.com/drive/folders/${folder.id}`
    };
  }

  /**
   * List Google Drive folders
   */
  async listFolders(maxResults = 20) {
    await this.rateLimit();
    const token = await this.getToken();
    const query = "mimeType='application/vnd.google-apps.folder' and trashed=false";
    const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&pageSize=${maxResults}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Failed to list folders');
    }
    const result = await response.json();
    // Return with 'documents' key so existing sidepanel code works unchanged
    return { success: true, documents: result.files || [] };
  }

  /**
   * Delete a file from Google Drive
   */
  async deleteFile(fileId) {
    await this.rateLimit();
    const token = await this.getToken();
    const response = await fetch(`${DRIVE_API_BASE}/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return { success: response.ok || response.status === 204 };
  }

  /**
   * List Google Docs inside a Drive folder
   */
  async listNotesInFolder(folderId) {
    await this.rateLimit();
    const token = await this.getToken();
    const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`;
    const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,createdTime)`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Failed to list folder notes');
    }
    const result = await response.json();
    return { success: true, files: result.files || [] };
  }

  /**
   * Create a Google Doc inside a Drive folder via Drive API
   */
  async createDocumentInFolder(title, folderId) {
    await this.rateLimit();
    const token = await this.getToken();
    const body = { name: title, mimeType: 'application/vnd.google-apps.document' };
    if (folderId) body.parents = [folderId];
    const response = await fetch(`${DRIVE_API_BASE}/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Failed to create document in folder');
    }
    const file = await response.json();
    return file.id; // returns documentId string
  }
}

// Export singleton instance
export const googleAPIClient = new GoogleAPIClient();

// Export class for testing
export { GoogleAPIClient };
