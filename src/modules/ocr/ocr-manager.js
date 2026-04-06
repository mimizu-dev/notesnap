/**
 * OCR Manager - Coordinates OCR text extraction using Tesseract.js
 * Runs in the service worker context
 */

import { logger } from '../utils/logger.js';
import '../../lib/tesseract.min.js';

let Tesseract = null;
let worker = null;
let isInitialized = false;

const log = logger.child('OCRManager');

/**
 * Initialize Tesseract.js worker
 */
export async function initOCR(language = 'eng') {
  if (isInitialized && worker) {
    log.info('OCR already initialized');
    return true;
  }

  try {
    log.info('Initializing Tesseract.js...');

    // Tesseract.js is loaded via static import and sets self.Tesseract as a side-effect
    Tesseract = self.Tesseract;

    if (!Tesseract) {
      throw new Error('Tesseract.js failed to load');
    }

    log.debug('Tesseract.js loaded');

    // Create worker
    worker = await Tesseract.createWorker(language, 1, {
      workerPath: chrome.runtime.getURL('src/lib/tesseract-worker.min.js'),
      corePath: chrome.runtime.getURL('src/lib/tesseract-core.wasm.js'),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: (m) => {
        if (m.status === 'recognizing text') {
          log.debug(`OCR progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });

    isInitialized = true;
    log.info('Tesseract.js initialized successfully');

    return true;
  } catch (error) {
    log.error('Failed to initialize Tesseract.js', error);
    isInitialized = false;
    worker = null;
    throw error;
  }
}

/**
 * Perform OCR on an image (data URL)
 */
export async function recognizeText(imageDataUrl, options = {}) {
  try {
    // Initialize if not already done
    if (!isInitialized) {
      await initOCR(options.language || 'eng');
    }

    if (!worker) {
      throw new Error('OCR worker not initialized');
    }

    log.info('Starting OCR recognition...');

    const startTime = Date.now();

    // Perform recognition
    const result = await worker.recognize(imageDataUrl);

    const duration = Date.now() - startTime;

    log.info(`OCR completed in ${duration}ms`, {
      confidence: result.data.confidence,
      textLength: result.data.text.length,
      blocks: result.data.blocks.length
    });

    return {
      success: true,
      text: result.data.text.trim(),
      confidence: result.data.confidence,
      blocks: result.data.blocks,
      words: result.data.words,
      lines: result.data.lines,
      duration: duration
    };

  } catch (error) {
    log.error('OCR recognition failed', error);

    return {
      success: false,
      error: error.message,
      text: ''
    };
  }
}

/**
 * Terminate the OCR worker
 */
export async function terminateOCR() {
  if (worker) {
    try {
      await worker.terminate();
      log.info('OCR worker terminated');
    } catch (error) {
      log.error('Failed to terminate OCR worker', error);
    }

    worker = null;
    isInitialized = false;
  }
}

/**
 * Check if OCR is ready
 */
export function isOCRReady() {
  return isInitialized && worker !== null;
}

/**
 * Get OCR status
 */
export function getOCRStatus() {
  return {
    initialized: isInitialized,
    ready: isOCRReady()
  };
}

/**
 * Reinitialize OCR with a different language
 */
export async function changeLanguage(language) {
  log.info(`Changing OCR language to: ${language}`);

  await terminateOCR();
  await initOCR(language);

  return true;
}
