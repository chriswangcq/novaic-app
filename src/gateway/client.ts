/**
 * gateway/client.ts — All Gateway REST calls.
 * Zero business logic. Zero knowledge of DB or Zustand.
 * Re-exports the existing `api` singleton so callers don't need to change.
 */
export { api as gateway } from '../services';
export type {
  AICAgent,
  AgentDeviceBinding,
  DeviceSubject,
  DeviceSubjectsResponse,
  DeviceToolCapabilitiesResponse,
  CreateAgentRequest,
  AppConfig,
  ApiKeyInfo,
  CandidateModel,
} from '../services/api';
