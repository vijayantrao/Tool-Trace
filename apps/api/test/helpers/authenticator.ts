/**
 * A software passkey (WebAuthn authenticator) for tests. It produces real
 * ES256 signatures and real CBOR attestation objects, so the server's
 * verification code runs exactly as it does for a phone or a security key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface StoredCredential {
  id: Buffer;
  privateKey: KeyObject;
  userHandle: string;
  signCount: number;
}

export class SoftAuthenticator {
  credential?: StoredCredential;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {}

  private authData(flags: number, signCount: number, attested?: Buffer) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(signCount);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
  }

  create(
    options: PublicKeyCredentialCreationOptionsJSON,
    overrides: { origin?: string } = {},
  ): RegistrationResponseJSON {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credId = randomBytes(16);

    const cosePublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credId.length);
    const attested = Buffer.concat([Buffer.alloc(16) /* aaguid */, credIdLen, credId, Buffer.from(cosePublicKey)]);

    const authData = this.authData(FLAG_UP | FLAG_UV | FLAG_AT, 0, attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, never>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, never>()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      }),
    );

    this.credential = { id: credId, privateKey, userHandle: options.user.id, signCount: 0 };
    return {
      id: b64url(credId),
      rawId: b64url(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    overrides: { origin?: string; challenge?: string; userVerified?: boolean } = {},
  ): AuthenticationResponseJSON {
    const cred = this.credential;
    if (!cred) throw new Error('No credential registered on this authenticator');
    cred.signCount += 1;

    const flags = FLAG_UP | (overrides.userVerified === false ? 0 : FLAG_UV);
    const authData = this.authData(flags, cred.signCount);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: overrides.challenge ?? options.challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);

    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: cred.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
