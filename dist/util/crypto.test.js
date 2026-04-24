/**
 * Tests for crypto utilities
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, hashToken, generateSecret } from './crypto';
describe('crypto utilities', () => {
    const TEST_KEY = 'test_encryption_key_that_is_at_least_32_chars!';
    beforeEach(() => {
        process.env.ENCRYPTION_KEY = TEST_KEY;
    });
    describe('encrypt / decrypt', () => {
        it('should encrypt and decrypt a bot token', () => {
            const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
            const encrypted = encrypt(token);
            const decrypted = decrypt(encrypted);
            expect(decrypted).toBe(token);
        });
        it('should produce different ciphertext each time (random IV)', () => {
            const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
            const encrypted1 = encrypt(token);
            const encrypted2 = encrypt(token);
            expect(encrypted1).not.toBe(encrypted2);
        });
        it('should not reveal plaintext in ciphertext', () => {
            const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
            const encrypted = encrypt(token);
            expect(encrypted).not.toContain(token);
        });
        it('should fail to decrypt with wrong key', () => {
            const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
            const encrypted = encrypt(token);
            process.env.ENCRYPTION_KEY = 'different_key_that_is_also_32_chars_long!';
            expect(() => decrypt(encrypted)).toThrow();
        });
    });
    describe('hashToken', () => {
        it('should produce a SHA-256 hash (64 hex chars)', () => {
            const hash = hashToken('123456789:ABCdefGHIjklMNOpqrsTUVwxyz');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
        it('should be deterministic', () => {
            const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);
            expect(hash1).toBe(hash2);
        });
        it('should produce different hashes for different tokens', () => {
            const hash1 = hashToken('token1');
            const hash2 = hashToken('token2');
            expect(hash1).not.toBe(hash2);
        });
    });
    describe('generateSecret', () => {
        it('should generate a base64url string', () => {
            const secret = generateSecret();
            expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
        });
        it('should generate different secrets each time', () => {
            const s1 = generateSecret();
            const s2 = generateSecret();
            expect(s1).not.toBe(s2);
        });
        it('should respect custom length', () => {
            const secret = generateSecret(32);
            // base64url encoding: 4 chars per 3 bytes
            // 32 bytes -> ~43 chars
            expect(secret.length).toBeGreaterThan(30);
        });
    });
});
