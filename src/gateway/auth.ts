/**
 * gateway/auth.ts — Re-exports from services/auth.ts.
 * Gateway layer's auth surface: get token, get current user.
 */
export {
  getCurrentUser,
  getAccessToken,
  appendTokenToUrl,
  fetchWithAuth,
  isAuthenticated,
  login,
  logout,
  register,
  type UserInfo,
} from '../services/auth';
