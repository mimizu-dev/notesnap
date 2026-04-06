/**
 * Speech Recognizer - Web Speech API wrapper for voice-to-text
 * Provides a clean interface for recording and transcribing speech
 */

export class SpeechRecognizer {
  constructor(options = {}) {
    this.language = options.language || 'en-US';
    this.continuous = options.continuous !== undefined ? options.continuous : true;
    this.interimResults = options.interimResults !== undefined ? options.interimResults : true;
    this.maxAlternatives = options.maxAlternatives || 1;

    this.recognition = null;
    this.isRecording = false;
    this.wantRecording = false;
    this.finalTranscript = '';
    this.interimTranscript = '';

    // Callbacks
    this.onStart = null;
    this.onEnd = null;
    this.onResult = null;
    this.onError = null;
    this.onInterimResult = null;

    // Check browser support
    this.isSupported = this.checkSupport();
  }

  /**
   * Check if Web Speech API is supported
   */
  checkSupport() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[SpeechRecognizer] Web Speech API not supported in this browser');
      return false;
    }
    return true;
  }

  /**
   * Initialize the speech recognition instance
   */
  initialize() {
    if (!this.isSupported) {
      throw new Error('Web Speech API not supported in this browser');
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();

    // Configure recognition
    this.recognition.continuous = this.continuous;
    this.recognition.interimResults = this.interimResults;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = this.maxAlternatives;

    // Setup event listeners
    this.setupEventListeners();

    console.log('[SpeechRecognizer] Initialized with language:', this.language);
  }

  /**
   * Setup event listeners for speech recognition
   */
  setupEventListeners() {
    // Recording started
    this.recognition.onstart = () => {
      console.log('[SpeechRecognizer] Recording started');
      this.isRecording = true;
      if (this.onStart) {
        this.onStart();
      }
    };

    // Recording ended
    this.recognition.onend = () => {
      console.log('[SpeechRecognizer] Recording ended');
      this.isRecording = false;
      // Auto-restart when user hasn't stopped intentionally (handles silence timeouts)
      if (this.wantRecording) {
        try {
          this.recognition.start();
          console.log('[SpeechRecognizer] Auto-restarting after silence...');
        } catch (e) {
          console.error('[SpeechRecognizer] Auto-restart failed:', e);
          this.wantRecording = false;
          if (this.onEnd) {
            this.onEnd({ finalTranscript: this.finalTranscript, interimTranscript: this.interimTranscript });
          }
        }
        return;
      }
      if (this.onEnd) {
        this.onEnd({
          finalTranscript: this.finalTranscript,
          interimTranscript: this.interimTranscript
        });
      }
    };

    // Results received
    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      // Process all results
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        const confidence = event.results[i][0].confidence;

        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
          console.log('[SpeechRecognizer] Final result:', transcript, 'Confidence:', confidence);
        } else {
          interimTranscript += transcript;
        }
      }

      // Update transcripts
      if (finalTranscript) {
        this.finalTranscript += finalTranscript;
      }
      this.interimTranscript = interimTranscript;

      // Call result callbacks
      if (finalTranscript && this.onResult) {
        this.onResult({
          transcript: finalTranscript.trim(),
          isFinal: true,
          fullTranscript: this.finalTranscript.trim()
        });
      }

      if (interimTranscript && this.onInterimResult) {
        this.onInterimResult({
          transcript: interimTranscript,
          isFinal: false,
          fullTranscript: this.finalTranscript.trim() + ' ' + interimTranscript
        });
      }
    };

    // Error handling
    this.recognition.onerror = (event) => {
      console.error('[SpeechRecognizer] Error:', event.error);

      let errorMessage = 'Speech recognition error';
      switch (event.error) {
        case 'no-speech':
          errorMessage = 'No speech detected. Please try again.';
          break;
        case 'audio-capture':
          errorMessage = 'No microphone found or permission denied.';
          break;
        case 'not-allowed':
          errorMessage = 'Microphone permission denied.';
          break;
        case 'network':
          errorMessage = 'Network error. Please check your connection.';
          break;
        case 'aborted':
          errorMessage = 'Recording aborted.';
          break;
        default:
          errorMessage = `Error: ${event.error}`;
      }

      if (this.onError) {
        this.onError({
          error: event.error,
          message: errorMessage
        });
      }
    };

    // Audio start/end
    this.recognition.onaudiostart = () => {
      console.log('[SpeechRecognizer] Audio capture started');
    };

    this.recognition.onaudioend = () => {
      console.log('[SpeechRecognizer] Audio capture ended');
    };

    // Sound start/end (actual speech detected)
    this.recognition.onsoundstart = () => {
      console.log('[SpeechRecognizer] Sound detected');
    };

    this.recognition.onsoundend = () => {
      console.log('[SpeechRecognizer] Sound ended');
    };

    // Speech start/end
    this.recognition.onspeechstart = () => {
      console.log('[SpeechRecognizer] Speech detected');
    };

    this.recognition.onspeechend = () => {
      console.log('[SpeechRecognizer] Speech ended');
    };
  }

  /**
   * Start recording
   */
  start() {
    if (!this.isSupported) {
      throw new Error('Web Speech API not supported');
    }

    if (this.isRecording || this.wantRecording) {
      console.warn('[SpeechRecognizer] Already recording');
      return;
    }

    // Initialize if not already done
    if (!this.recognition) {
      this.initialize();
    }

    // Reset transcripts for a fresh user-initiated start
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.wantRecording = true;

    try {
      this.recognition.start();
      console.log('[SpeechRecognizer] Starting recording...');
    } catch (error) {
      console.error('[SpeechRecognizer] Failed to start:', error);
      this.wantRecording = false;
      throw error;
    }
  }

  /**
   * Stop recording
   */
  stop() {
    this.wantRecording = false;
    if (!this.isRecording) {
      console.warn('[SpeechRecognizer] Not currently recording');
      return;
    }

    try {
      this.recognition.stop();
      console.log('[SpeechRecognizer] Stopping recording...');
    } catch (error) {
      console.error('[SpeechRecognizer] Failed to stop:', error);
      throw error;
    }
  }

  /**
   * Abort recording
   */
  abort() {
    if (this.recognition) {
      try {
        this.recognition.abort();
        console.log('[SpeechRecognizer] Recording aborted');
      } catch (error) {
        console.error('[SpeechRecognizer] Failed to abort:', error);
      }
    }
  }

  /**
   * Get current transcript
   */
  getTranscript() {
    return {
      final: this.finalTranscript.trim(),
      interim: this.interimTranscript,
      full: (this.finalTranscript + ' ' + this.interimTranscript).trim()
    };
  }

  /**
   * Change recognition language
   */
  setLanguage(language) {
    this.language = language;
    if (this.recognition) {
      this.recognition.lang = language;
      console.log('[SpeechRecognizer] Language changed to:', language);
    }
  }

  /**
   * Check if currently recording
   */
  isActive() {
    return this.isRecording || this.wantRecording;
  }

  /**
   * Check if browser supports speech recognition
   */
  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * Get supported languages (common ones)
   */
  static getSupportedLanguages() {
    return [
      { code: 'en-US', name: 'English (US)' },
      { code: 'en-GB', name: 'English (UK)' },
      { code: 'es-ES', name: 'Spanish (Spain)' },
      { code: 'es-MX', name: 'Spanish (Mexico)' },
      { code: 'fr-FR', name: 'French' },
      { code: 'de-DE', name: 'German' },
      { code: 'it-IT', name: 'Italian' },
      { code: 'pt-BR', name: 'Portuguese (Brazil)' },
      { code: 'zh-CN', name: 'Chinese (Simplified)' },
      { code: 'ja-JP', name: 'Japanese' },
      { code: 'ko-KR', name: 'Korean' },
      { code: 'ru-RU', name: 'Russian' },
      { code: 'ar-SA', name: 'Arabic' },
      { code: 'hi-IN', name: 'Hindi' }
    ];
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    this.wantRecording = false;
    if (this.recognition) {
      if (this.isRecording) {
        this.abort();
      }
      this.recognition = null;
    }
    this.onStart = null;
    this.onEnd = null;
    this.onResult = null;
    this.onError = null;
    this.onInterimResult = null;
  }
}

/**
 * Helper function to create a speech recognizer
 */
export function createSpeechRecognizer(options = {}) {
  return new SpeechRecognizer(options);
}

/**
 * Check if speech recognition is supported
 */
export function isSpeechRecognitionSupported() {
  return SpeechRecognizer.isSupported();
}
