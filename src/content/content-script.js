/**
 * Content Script - Injected into YouTube and Udemy pages
 * Main entry point for video detection and frame capture
 */

import { VideoDetector } from './video-detector.js';
import { FrameCapturer } from './frame-capturer.js';

console.log('[VideoNotes] Content script loaded on:', window.location.href);

// Initialize modules
const videoDetector = new VideoDetector();
const frameCapturer = new FrameCapturer(0.9); // 90% quality

let currentVideo = null;

// Start video detection
videoDetector.startDetection();

// Listen for video detection
videoDetector.onVideoDetected((video) => {
  console.log('[VideoNotes] Video detected and ready for capture');
  currentVideo = video;

  // Notify service worker that video is ready
  chrome.runtime.sendMessage({
    type: 'VIDEO_DETECTED',
    payload: {
      metadata: videoDetector.getVideoMetadata(),
      pageMetadata: videoDetector.getPageMetadata(),
      canCapture: frameCapturer.canCapture(video)
    }
  }).catch(err => console.error('[VideoNotes] Failed to notify video detection:', err));
});

/**
 * Handle messages from service worker and side panel
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[VideoNotes] Content script received message:', message.type);

  // Handle async messages
  handleMessage(message, sender)
    .then(response => sendResponse(response))
    .catch(error => {
      console.error('[VideoNotes] Message handler error:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    });

  return true; // Keep channel open for async response
});

/**
 * Handle different message types
 */
async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CAPTURE_FRAME':
      return await handleCaptureFrame(message.payload);

    case 'GET_VIDEO_STATUS':
      return handleGetVideoStatus();

    case 'CHECK_VIDEO_READY':
      return handleCheckVideoReady();

    default:
      console.warn('[VideoNotes] Unknown message type:', message.type);
      return { success: false, error: 'Unknown message type' };
  }
}

/**
 * Handle frame capture request
 */
async function handleCaptureFrame(payload = {}) {
  try {
    // Get current video or detect one
    const video = currentVideo || videoDetector.getCurrentVideo();

    if (!video) {
      throw new Error('No video found on page');
    }

    // Check if video is ready
    if (video.readyState < 2) {
      throw new Error('Video not ready for capture');
    }

    // Check CORS restrictions
    const captureCheck = frameCapturer.canCapture(video);
    if (!captureCheck.canCapture) {
      throw new Error(`Cannot capture: ${captureCheck.error}`);
    }

    console.log('[VideoNotes] Capturing frame...');

    // Capture frame with optimization
    const frameData = await frameCapturer.captureFrameOptimized(
      video,
      payload.targetSizeKB || 500
    );

    // Get video and page metadata
    const videoMetadata = videoDetector.getVideoMetadata();
    const pageMetadata = videoDetector.getPageMetadata();

    console.log('[VideoNotes] Frame captured successfully:', {
      size: `${frameData.sizeKB} KB`,
      dimensions: `${frameData.width}x${frameData.height}`,
      timestamp: videoDetector.getCurrentTimestamp()
    });

    return {
      success: true,
      frameData: {
        dataUrl: frameData.dataUrl,
        width: frameData.width,
        height: frameData.height,
        sizeKB: frameData.sizeKB,
        timestamp: videoDetector.getCurrentTimestamp(),
        videoCurrentTime: video.currentTime
      },
      videoMetadata: videoMetadata,
      pageMetadata: pageMetadata
    };

  } catch (error) {
    console.error('[VideoNotes] Frame capture failed:', error);

    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle get video status request
 */
function handleGetVideoStatus() {
  const video = currentVideo || videoDetector.getCurrentVideo();

  if (!video) {
    return {
      success: true,
      hasVideo: false,
      message: 'No video found on page'
    };
  }

  const videoMetadata = videoDetector.getVideoMetadata();
  const pageMetadata = videoDetector.getPageMetadata();
  const captureCheck = frameCapturer.canCapture(video);

  return {
    success: true,
    hasVideo: true,
    canCapture: captureCheck.canCapture,
    captureError: captureCheck.error,
    videoMetadata: videoMetadata,
    pageMetadata: pageMetadata,
    timestamp: videoDetector.getCurrentTimestamp()
  };
}

/**
 * Handle check video ready request
 */
function handleCheckVideoReady() {
  const video = currentVideo || videoDetector.getCurrentVideo();

  return {
    success: true,
    ready: video && video.readyState >= 2,
    hasVideo: !!video,
    platform: videoDetector.getPageMetadata().platform
  };
}

/**
 * Inject capture button UI (optional floating button)
 */
function injectCaptureButton() {
  // Check if button already exists
  if (document.getElementById('video-notes-capture-btn')) {
    return;
  }

  // Create floating capture button
  const button = document.createElement('button');
  button.id = 'video-notes-capture-btn';
  button.innerHTML = '📸';
  button.title = 'Capture video frame (Video Notes Extension)';
  button.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 20px;
    z-index: 9999;
    width: 50px;
    height: 50px;
    border-radius: 50%;
    background-color: #4285f4;
    color: white;
    border: none;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    transition: all 0.2s;
  `;

  // Hover effect
  button.addEventListener('mouseenter', () => {
    button.style.transform = 'scale(1.1)';
    button.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.4)';
  });

  button.addEventListener('mouseleave', () => {
    button.style.transform = 'scale(1)';
    button.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.3)';
  });

  // Click handler
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.innerHTML = '⏳';

    try {
      const result = await handleCaptureFrame();

      if (result.success) {
        // Show success feedback
        button.innerHTML = '✅';
        setTimeout(() => {
          button.innerHTML = '📸';
          button.disabled = false;
        }, 1500);

        // Send to background for processing
        chrome.runtime.sendMessage({
          type: 'FRAME_CAPTURED',
          payload: result
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('[VideoNotes] Capture failed:', error);
      button.innerHTML = '❌';
      setTimeout(() => {
        button.innerHTML = '📸';
        button.disabled = false;
      }, 2000);

      alert('Failed to capture frame: ' + error.message);
    }
  });

  document.body.appendChild(button);

  console.log('[VideoNotes] Capture button injected');
}

// Optionally inject floating capture button when video is detected
// Uncomment this to enable the floating button:
// videoDetector.onVideoDetected(() => {
//   setTimeout(injectCaptureButton, 1000);
// });

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  videoDetector.destroy();
  frameCapturer.destroy();
});

console.log('[VideoNotes] Content script initialized and ready');
