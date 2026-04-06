/**
 * Video Detector - Detects and monitors video elements on YouTube and Udemy
 */

export class VideoDetector {
  constructor() {
    this.currentVideo = null;
    this.observers = [];
    this.detectionCallbacks = [];
  }

  /**
   * Start detecting video elements on the page
   */
  startDetection() {
    console.log('[VideoDetector] Starting video detection...');

    // Detect immediately
    this.detectVideo();

    // Set up mutation observer for dynamic content (YouTube SPA)
    this.setupMutationObserver();

    // Set up interval check as backup
    this.setupIntervalCheck();
  }

  /**
   * Detect video element on the page
   */
  detectVideo() {
    const video = this.findVideoElement();

    if (video && video !== this.currentVideo) {
      console.log('[VideoDetector] Video detected:', {
        src: video.currentSrc || video.src,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration
      });

      this.currentVideo = video;
      this.notifyDetection(video);
      this.setupVideoEventListeners(video);
    }

    return video;
  }

  /**
   * Find the main video element on the page
   */
  findVideoElement() {
    // Priority order for finding videos
    const selectors = [
      // YouTube selectors
      'video.html5-main-video',
      'video.video-stream',

      // Udemy selectors
      'video[data-purpose="video-player"]',
      'video.vjs-tech',

      // Generic fallback
      'video'
    ];

    for (const selector of selectors) {
      const video = document.querySelector(selector);
      if (video && this.isValidVideo(video)) {
        return video;
      }
    }

    return null;
  }

  /**
   * Check if video element is valid for capture
   */
  isValidVideo(video) {
    // Must be a video element
    if (!(video instanceof HTMLVideoElement)) {
      return false;
    }

    // Must have dimensions
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return false;
    }

    // Must not be hidden
    if (video.style.display === 'none' || video.hidden) {
      return false;
    }

    // Check if actually visible
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    return true;
  }

  /**
   * Setup mutation observer to detect dynamically loaded videos
   */
  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      // Throttle detection to avoid excessive checks
      if (!this.detectionPending) {
        this.detectionPending = true;
        setTimeout(() => {
          this.detectVideo();
          this.detectionPending = false;
        }, 500);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.observers.push(observer);
  }

  /**
   * Setup interval check as backup (for lazy-loaded videos)
   */
  setupIntervalCheck() {
    const intervalId = setInterval(() => {
      if (!this.currentVideo) {
        this.detectVideo();
      }
    }, 2000); // Check every 2 seconds

    this.intervals = this.intervals || [];
    this.intervals.push(intervalId);
  }

  /**
   * Setup event listeners on the video element
   */
  setupVideoEventListeners(video) {
    // Log video events for debugging
    const events = ['loadedmetadata', 'loadeddata', 'play', 'pause', 'ended', 'error'];

    events.forEach(eventName => {
      video.addEventListener(eventName, (e) => {
        console.log(`[VideoDetector] Video event: ${eventName}`, {
          currentTime: video.currentTime,
          duration: video.duration,
          paused: video.paused
        });
      });
    });
  }

  /**
   * Register a callback for video detection
   */
  onVideoDetected(callback) {
    this.detectionCallbacks.push(callback);

    // If video already detected, call immediately
    if (this.currentVideo) {
      callback(this.currentVideo);
    }
  }

  /**
   * Notify all callbacks about video detection
   */
  notifyDetection(video) {
    this.detectionCallbacks.forEach(callback => {
      try {
        callback(video);
      } catch (error) {
        console.error('[VideoDetector] Error in detection callback:', error);
      }
    });
  }

  /**
   * Get current video element
   */
  getCurrentVideo() {
    return this.currentVideo;
  }

  /**
   * Get video metadata
   */
  getVideoMetadata() {
    if (!this.currentVideo) {
      return null;
    }

    const video = this.currentVideo;

    return {
      src: video.currentSrc || video.src,
      currentTime: video.currentTime,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      playbackRate: video.playbackRate,
      readyState: video.readyState
    };
  }

  /**
   * Format current video timestamp as MM:SS
   */
  getCurrentTimestamp() {
    if (!this.currentVideo) {
      return '0:00';
    }

    const seconds = Math.floor(this.currentVideo.currentTime);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  /**
   * Get page metadata (YouTube/Udemy specific)
   */
  getPageMetadata() {
    const url = window.location.href;
    let pageTitle = document.title;
    let platform = 'unknown';

    // YouTube specific
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      platform = 'YouTube';
      const titleElement = document.querySelector('h1.ytd-video-primary-info-renderer, h1.title yt-formatted-string');
      if (titleElement) {
        pageTitle = titleElement.textContent.trim();
      }
    }

    // Udemy specific
    if (url.includes('udemy.com')) {
      platform = 'Udemy';
      const titleElement = document.querySelector('[data-purpose="course-title"], h1.course-title');
      if (titleElement) {
        pageTitle = titleElement.textContent.trim();
      }
    }

    return {
      title: pageTitle,
      url: url,
      platform: platform
    };
  }

  /**
   * Check if currently on a supported platform
   */
  isSupportedPlatform() {
    const url = window.location.href;
    return url.includes('youtube.com') ||
           url.includes('youtu.be') ||
           url.includes('udemy.com');
  }

  /**
   * Cleanup observers and intervals
   */
  destroy() {
    console.log('[VideoDetector] Destroying...');

    // Clear observers
    this.observers.forEach(observer => observer.disconnect());
    this.observers = [];

    // Clear intervals
    if (this.intervals) {
      this.intervals.forEach(intervalId => clearInterval(intervalId));
      this.intervals = [];
    }

    // Clear callbacks
    this.detectionCallbacks = [];
    this.currentVideo = null;
  }
}
