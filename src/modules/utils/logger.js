/**
 * Logger utility for the Video Notes Extension
 * Provides structured logging with different severity levels
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

class Logger {
  constructor(context = 'VideoNotes') {
    this.context = context;
    this.minLevel = LOG_LEVELS.DEBUG; // Can be configured via settings
  }

  /**
   * Format log message with timestamp and context
   */
  formatMessage(level, message, data) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.context}]`;

    if (data) {
      return `${prefix} ${message}`;
    }
    return `${prefix} ${message}`;
  }

  /**
   * Debug level logging
   */
  debug(message, data = null) {
    if (this.minLevel <= LOG_LEVELS.DEBUG) {
      console.debug(this.formatMessage('DEBUG', message, data), data || '');
    }
  }

  /**
   * Info level logging
   */
  info(message, data = null) {
    if (this.minLevel <= LOG_LEVELS.INFO) {
      console.info(this.formatMessage('INFO', message, data), data || '');
    }
  }

  /**
   * Warning level logging
   */
  warn(message, data = null) {
    if (this.minLevel <= LOG_LEVELS.WARN) {
      console.warn(this.formatMessage('WARN', message, data), data || '');
    }
  }

  /**
   * Error level logging
   */
  error(message, error = null) {
    if (this.minLevel <= LOG_LEVELS.ERROR) {
      console.error(this.formatMessage('ERROR', message, error));
      if (error) {
        console.error(error);
      }
    }
  }

  /**
   * Create a child logger with a specific sub-context
   */
  child(subContext) {
    return new Logger(`${this.context}:${subContext}`);
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for creating custom loggers
export { Logger, LOG_LEVELS };
