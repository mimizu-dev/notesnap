/**
 * Frame Capturer - Captures video frames to canvas and converts to images
 */

export class FrameCapturer {
  constructor(quality = 0.9) {
    this.quality = quality; // JPEG quality (0.0 - 1.0)
    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Capture current frame from a video element
   * @param {HTMLVideoElement} videoElement - The video element to capture from
   * @param {Object} options - Capture options
   * @returns {Object} Captured frame data
   */
  captureFrame(videoElement, options = {}) {
    if (!videoElement || !(videoElement instanceof HTMLVideoElement)) {
      throw new Error('Invalid video element');
    }

    if (videoElement.readyState < 2) {
      throw new Error('Video not ready for capture (readyState < 2)');
    }

    const {
      maxWidth = 1920,
      maxHeight = 1080,
      quality = this.quality,
      format = 'image/jpeg'
    } = options;

    try {
      // Get video dimensions
      const videoWidth = videoElement.videoWidth;
      const videoHeight = videoElement.videoHeight;

      if (videoWidth === 0 || videoHeight === 0) {
        throw new Error('Video has no dimensions');
      }

      // Calculate scaled dimensions while maintaining aspect ratio
      const dimensions = this.calculateDimensions(
        videoWidth,
        videoHeight,
        maxWidth,
        maxHeight
      );

      console.log('[FrameCapturer] Capturing frame:', {
        original: { width: videoWidth, height: videoHeight },
        scaled: dimensions,
        quality: quality,
        format: format
      });

      // Create or resize canvas
      this.setupCanvas(dimensions.width, dimensions.height);

      // Draw video frame to canvas
      this.ctx.drawImage(
        videoElement,
        0, 0,
        videoWidth, videoHeight,
        0, 0,
        dimensions.width, dimensions.height
      );

      // Convert canvas to data URL
      const dataUrl = this.canvas.toDataURL(format, quality);

      // Calculate file size
      const sizeInBytes = Math.round((dataUrl.length * 3) / 4);
      const sizeInKB = (sizeInBytes / 1024).toFixed(2);

      console.log('[FrameCapturer] Frame captured:', {
        size: `${sizeInKB} KB`,
        dimensions: dimensions
      });

      // Get additional metadata
      const frameData = {
        dataUrl: dataUrl,
        width: dimensions.width,
        height: dimensions.height,
        originalWidth: videoWidth,
        originalHeight: videoHeight,
        timestamp: videoElement.currentTime,
        format: format,
        quality: quality,
        sizeKB: parseFloat(sizeInKB),
        capturedAt: Date.now()
      };

      return frameData;

    } catch (error) {
      console.error('[FrameCapturer] Capture failed:', error);

      // Check for CORS errors
      if (error.name === 'SecurityError') {
        throw new Error('CORS error: Cannot capture frame due to cross-origin restrictions');
      }

      throw error;
    }
  }

  /**
   * Calculate scaled dimensions while maintaining aspect ratio
   */
  calculateDimensions(videoWidth, videoHeight, maxWidth, maxHeight) {
    let width = videoWidth;
    let height = videoHeight;

    // Scale down if too large
    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }

    if (height > maxHeight) {
      width = Math.round((width * maxHeight) / height);
      height = maxHeight;
    }

    return { width, height };
  }

  /**
   * Setup or resize canvas
   */
  setupCanvas(width, height) {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', {
        alpha: false, // No transparency for JPEG
        willReadFrequently: false
      });
    }

    // Only resize if dimensions changed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Convert data URL to Blob
   */
  dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then(res => res.blob());
  }

  /**
   * Capture frame and return as Blob
   */
  async captureFrameAsBlob(videoElement, options = {}) {
    const frameData = this.captureFrame(videoElement, options);
    const blob = await this.dataUrlToBlob(frameData.dataUrl);

    return {
      ...frameData,
      blob: blob
    };
  }

  /**
   * Capture frame with automatic quality adjustment
   * Reduces quality if file size is too large
   */
  async captureFrameOptimized(videoElement, targetSizeKB = 500) {
    let quality = this.quality;
    let frameData = null;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      frameData = this.captureFrame(videoElement, { quality });

      console.log('[FrameCapturer] Optimization attempt', attempts + 1, {
        quality: quality,
        sizeKB: frameData.sizeKB,
        targetKB: targetSizeKB
      });

      // If size is acceptable, return
      if (frameData.sizeKB <= targetSizeKB || quality <= 0.3) {
        break;
      }

      // Reduce quality and try again
      quality -= 0.15;
      attempts++;
    }

    console.log('[FrameCapturer] Optimized capture complete:', {
      finalQuality: quality,
      finalSizeKB: frameData.sizeKB,
      attempts: attempts + 1
    });

    return frameData;
  }

  /**
   * Test if video can be captured (CORS check)
   */
  canCapture(videoElement) {
    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 1;
      tempCanvas.height = 1;
      const tempCtx = tempCanvas.getContext('2d');

      tempCtx.drawImage(videoElement, 0, 0, 1, 1);
      tempCanvas.toDataURL(); // This will throw if CORS restricted

      return { canCapture: true, error: null };
    } catch (error) {
      console.warn('[FrameCapturer] Cannot capture video:', error);

      return {
        canCapture: false,
        error: error.name === 'SecurityError' ? 'CORS restriction' : error.message
      };
    }
  }

  /**
   * Get estimated capture size without actually capturing
   */
  estimateCaptureSize(videoElement, quality = 0.9) {
    const width = videoElement.videoWidth;
    const height = videoElement.videoHeight;

    // Rough estimation based on dimensions and quality
    // JPEG typically uses ~2-4 bytes per pixel depending on quality
    const bytesPerPixel = 2 + (quality * 2);
    const estimatedBytes = width * height * bytesPerPixel;
    const estimatedKB = estimatedBytes / 1024;

    return {
      estimatedKB: Math.round(estimatedKB),
      width: width,
      height: height,
      quality: quality
    };
  }

  /**
   * Cleanup canvas
   */
  destroy() {
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = null;
      this.ctx = null;
    }
  }
}

/**
 * Utility function to create a capturer with default settings
 */
export function createFrameCapturer(quality = 0.9) {
  return new FrameCapturer(quality);
}
