/**
 * Cryptography utilities for encrypting sensitive data (bot tokens).
 * Uses AES-256-GCM via Node.js built-in crypto module.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';
import { crypto as cryptoLog } from './logger';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1 };
/**
 * Derive a 256-bit key from the ENCRYPTION_KEY env var using scrypt.
 */
function deriveKey(salt) {
    const secret = process.env.ENCRYPTION_KEY ?? '';
    if (!secret) {
        cryptoLog.keyNotSet();
        throw new Error('ENCRYPTION_KEY is not set in environment');
    }
    return scryptSync(secret, salt, KEY_LENGTH, SCRYPT_PARAMS);
}
/**
 * Encrypt a plaintext string (e.g., bot token).
 * Returns base64-encoded string: salt (32B) + iv (16B) + ciphertext + authTag (16B)
 */
export function encrypt(plaintext) {
    const salt = randomBytes(SALT_LENGTH);
    const key = deriveKey(salt);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Concatenate: salt + iv + authTag + ciphertext
    return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}
/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 */
export function decrypt(ciphertext) {
    const raw = Buffer.from(ciphertext, 'base64');
    const salt = raw.subarray(0, SALT_LENGTH);
    const iv = raw.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = raw.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = raw.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const key = deriveKey(salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}
/**
 * Create a SHA-256 hash of a string (used for bot token lookup).
 */
export function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
/**
 * Generate a random secret string for webhook verification.
 */
export function generateSecret(length = 48) {
    return randomBytes(length).toString('base64url');
}
