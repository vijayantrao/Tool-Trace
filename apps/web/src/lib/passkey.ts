import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { api, ApiError, errorText } from './api';
import type { Me } from './types';

/** Turns the many ways a passkey ceremony can fail into one clear sentence. */
function passkeyError(err: unknown, action: 'sign in' | 'create your passkey'): string {
  const name = err instanceof WebAuthnError ? err.cause instanceof Error ? err.cause.name : err.name : (err as Error)?.name;
  if (name === 'NotAllowedError' || name === 'ERROR_CEREMONY_ABORTED') {
    return `Passkey request was cancelled or timed out. Try again to ${action}.`;
  }
  if (name === 'InvalidStateError') return 'This device already has a passkey for ToolTrace. Use "Sign in" instead.';
  if (name === 'NotSupportedError') return 'This browser does not support passkeys. Try an up-to-date Chrome, Edge or Safari.';
  if (name === 'SecurityError') return 'Passkeys need a secure connection (https) on the correct web address.';
  if (err instanceof ApiError) return errorText(err);
  return `Could not ${action}. Try again.`;
}

export async function signInWithPasskey(): Promise<Me> {
  try {
    const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/login/options', {
      method: 'POST',
      body: {},
    });
    const response = await startAuthentication({ optionsJSON });
    return (await api<{ user: Me }>('/auth/login/verify', { body: { response } })).user;
  } catch (err) {
    throw new Error(passkeyError(err, 'sign in'));
  }
}

export async function registerPasskey(inviteToken: string, displayName: string): Promise<Me> {
  try {
    const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/register/options', {
      body: { inviteToken },
    });
    const response = await startRegistration({ optionsJSON });
    return (await api<{ user: Me }>('/auth/register/verify', { body: { displayName, response } })).user;
  } catch (err) {
    throw new Error(passkeyError(err, 'create your passkey'));
  }
}
