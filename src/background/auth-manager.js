/**
 * Auth Manager - Google OAuth2 authentication using chrome.identity
 * Handles token lifecycle: retrieval, caching, refresh, and revocation
 */

import { logger } from '../modules/utils/logger.js';

const log = logger.child('AuthManager');

// OAuth2 scopes required for the extension
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email'
];

// Token expiry buffer (refresh 5 minutes before actual expiry)
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Token validity duration (Google tokens typically valid for 1 hour)
const TOKEN_VALIDITY_MS = 59 * 60 * 1000; // 59 minutes

class AuthManager {
  constructor() {
    this.authInProgress = false;
  }

  /**
   * Get a valid OAuth2 token
   * Returns cached token if still valid, otherwise gets a new one
   */
  async getValidToken(interactive = false) {
    try {
      // Check cached token first
      const cached = await this.getCachedAuth();

      if (cached && cached.token && this.isTokenValid(cached)) {
        log.debug('Using cached token');
        return {
          success: true,
          token: cached.token,
          email: cached.email,
          fromCache: true
        };
      }

      // Remove stale cached token if exists
      if (cached && cached.token) {
        log.info('Cached token expired, removing...');
        await this.removeCachedToken(cached.token);
      }

      // Get new token
      log.info(`Getting new token (interactive: ${interactive})`);
      const token = await this.getNewToken(interactive);

      // Get user info
      const userInfo = await this.getUserInfo(token);

      // Cache the token
      await this.cacheAuth(token, userInfo.email);

      return {
        success: true,
        token: token,
        email: userInfo.email,
        fromCache: false
      };

    } catch (error) {
      log.error('Failed to get valid token', error);

      return {
        success: false,
        error: error.message,
        token: null
      };
    }
  }

  /**
   * Get a new token from chrome.identity API
   */
  async getNewToken(interactive = false) {
    if (this.authInProgress) {
      throw new Error('Authentication already in progress');
    }

    this.authInProgress = true;

    try {
      const token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken(
          {
            interactive: interactive,
            scopes: OAUTH_SCOPES
          },
          (token) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!token) {
              reject(new Error('No token returned'));
            } else {
              resolve(token);
            }
          }
        );
      });

      log.info('New token obtained');
      return token;

    } finally {
      this.authInProgress = false;
    }
  }

  /**
   * Get cached authentication data
   */
  async getCachedAuth() {
    try {
      const result = await chrome.storage.local.get('auth');
      return result.auth || null;
    } catch (error) {
      log.error('Failed to get cached auth', error);
      return null;
    }
  }

  /**
   * Cache authentication data
   */
  async cacheAuth(token, email) {
    const auth = {
      token: token,
      email: email,
      expiresAt: Date.now() + TOKEN_VALIDITY_MS,
      createdAt: Date.now()
    };

    await chrome.storage.local.set({ auth });
    log.info('Token cached', { email, expiresAt: new Date(auth.expiresAt).toISOString() });
  }

  /**
   * Check if cached token is still valid
   */
  isTokenValid(auth) {
    if (!auth || !auth.token || !auth.expiresAt) {
      return false;
    }

    // Check if token expired (with buffer)
    const now = Date.now();
    const expiresWithBuffer = auth.expiresAt - EXPIRY_BUFFER_MS;

    if (now >= expiresWithBuffer) {
      log.debug('Token expired or expiring soon');
      return false;
    }

    return true;
  }

  /**
   * Remove cached token from chrome.identity
   */
  async removeCachedToken(token) {
    return new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken(
        { token: token },
        () => {
          if (chrome.runtime.lastError) {
            log.warn('Error removing cached token:', chrome.runtime.lastError);
          } else {
            log.info('Cached token removed');
          }
          resolve();
        }
      );
    });
  }

  /**
   * Get user info from Google API
   */
  async getUserInfo(token) {
    try {
      const response = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get user info: ${response.status}`);
      }

      const userInfo = await response.json();

      log.info('User info retrieved', { email: userInfo.email });

      return {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        verified: userInfo.verified_email
      };

    } catch (error) {
      log.error('Failed to get user info', error);
      // Return minimal info on failure
      return {
        email: 'unknown',
        name: 'Unknown User',
        picture: null,
        verified: false
      };
    }
  }

  /**
   * Perform user login (interactive OAuth flow)
   */
  async login() {
    try {
      log.info('Starting login flow...');

      const result = await this.getValidToken(true);

      if (!result.success) {
        throw new Error(result.error || 'Login failed');
      }

      log.info('Login successful', { email: result.email });

      return {
        success: true,
        email: result.email,
        token: result.token
      };

    } catch (error) {
      log.error('Login failed', error);

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Perform user logout
   */
  async logout() {
    try {
      log.info('Starting logout...');

      // Get cached auth
      const cached = await this.getCachedAuth();

      // Revoke token if exists
      if (cached && cached.token) {
        await this.revokeToken(cached.token);
        await this.removeCachedToken(cached.token);
      }

      // Clear cached auth from storage
      await chrome.storage.local.remove('auth');

      log.info('Logout successful');

      return {
        success: true
      };

    } catch (error) {
      log.error('Logout failed', error);

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Revoke token at Google
   */
  async revokeToken(token) {
    try {
      const response = await fetch(
        `https://accounts.google.com/o/oauth2/revoke?token=${token}`,
        { method: 'POST' }
      );

      if (response.ok) {
        log.info('Token revoked at Google');
      } else {
        log.warn('Failed to revoke token at Google:', response.status);
      }
    } catch (error) {
      log.warn('Error revoking token:', error);
    }
  }

  /**
   * Get current authentication status
   */
  async getAuthStatus() {
    try {
      const cached = await this.getCachedAuth();

      if (!cached || !cached.token) {
        return {
          authenticated: false,
          isAuthenticated: false, // Also provide isAuthenticated for compatibility
          email: null,
          expiresAt: null
        };
      }

      const isValid = this.isTokenValid(cached);

      return {
        authenticated: isValid,
        isAuthenticated: isValid, // Also provide isAuthenticated for compatibility
        email: cached.email,
        expiresAt: cached.expiresAt,
        expiresIn: cached.expiresAt ? Math.max(0, cached.expiresAt - Date.now()) : 0,
        isExpiring: cached.expiresAt ? (cached.expiresAt - Date.now() < EXPIRY_BUFFER_MS) : false
      };

    } catch (error) {
      log.error('Failed to get auth status', error);

      return {
        authenticated: false,
        isAuthenticated: false, // Also provide isAuthenticated for compatibility
        email: null,
        error: error.message
      };
    }
  }

  /**
   * Refresh token if expiring soon
   */
  async refreshIfNeeded() {
    try {
      const status = await this.getAuthStatus();

      if (!status.authenticated) {
        log.debug('Not authenticated, skipping refresh');
        return { success: false, reason: 'not_authenticated' };
      }

      if (!status.isExpiring) {
        log.debug('Token not expiring soon, skipping refresh');
        return { success: false, reason: 'not_needed' };
      }

      log.info('Token expiring soon, refreshing...');
      const result = await this.getValidToken(false);

      return {
        success: result.success,
        refreshed: true
      };

    } catch (error) {
      log.error('Failed to refresh token', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if user has granted required scopes
   */
  async hasRequiredScopes() {
    // This would require checking granted scopes via Google API
    // For now, assume granted if we have a valid token
    const status = await this.getAuthStatus();
    return status.authenticated;
  }
}

// Export singleton instance
export const authManager = new AuthManager();

// Export class for testing
export { AuthManager };
