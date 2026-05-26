import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../';

describe('Cloudflare Worker - Failover & Cache Proxy', () => {
    // We define clean variables that we re-assign in beforeEach
    let env;
    let ctx;

    beforeEach(() => {
        env = {
            BASE_URL: '["https://primary.com/%s", "https://backup.com/%s"]',
            USER_MAP: '{"alias": "real_user"}',
            USER_BAN: '["banned_user"]',
        };

        // Fresh spy for ctx.waitUntil on every test
        ctx = {
            waitUntil: vi.fn((promise) => promise),
        };

        // Mock global fetch
        globalThis.fetch = vi.fn();

        // Fresh mock for global Cloudflare Cache API
        globalThis.caches = {
            default: {
                match: vi.fn().mockResolvedValue(null),
                put: vi.fn().mockResolvedValue(true),
            },
        };
    });

    it('should return 422 if BASE_URL is completely missing (Lines 15-16)', async () => {
        delete env.BASE_URL;
        const request = new Request('https://worker.local/real_user');

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(422);
        expect(response.headers.get('status-message')).toContain('BASE_URL is not defined');
    });

    it('should fallback to treating BASE_URL as a plain string if JSON.parse fails (Line 27)', async () => {
        // Change BASE_URL into a plain unparseable string with a placeholder
        env.BASE_URL = 'https://fallback-single-server.com/%s';
        const request = new Request('https://worker.local/real_user');

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('fallback_ok', { status: 200 }));

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('fallback_ok');
        expect(globalThis.fetch).toHaveBeenCalledWith('https://fallback-single-server.com/real_user', expect.any(Request));
    });

    it('should return 400 Bad Request if the user identifier path is empty (Lines 40-41)', async () => {
        const request = new Request('https://worker.local/');

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(400);
        expect(response.headers.get('status-message')).toContain('User identifier is missing');
    });

    it('should correctly remap user according to USER_MAP', async () => {
        const request = new Request('https://worker.local/alias');

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('data', { status: 200 }));

        await worker.fetch(request, env, ctx);

        expect(globalThis.fetch).toHaveBeenCalledWith('https://primary.com/real_user', expect.any(Request));
    });

    it('should instantly return cached response on cache hit (Lines 68-69)', async () => {
        const request = new Request('https://worker.local/real_user');
        const simulatedCachedResponse = new Response('cached_data_xyz', { status: 200 });

        // Force cache match to resolve with a mock response instead of null
        vi.spyOn(globalThis.caches.default, 'match').mockResolvedValueOnce(simulatedCachedResponse);

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('cached_data_xyz');
        // Cache hit must bypass the upstream fetch network layer completely
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should successfully fetch data from primary upstream and cache it', async () => {
        const request = new Request('https://worker.local/real_user');

        const mockResponse = new Response('user_data_123', { status: 200, statusText: 'OK' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(200);

        // FIX: Clone the response before reading text, so we don't disturb the stream
        const clonedResponse = response.clone();
        expect(await clonedResponse.text()).toBe('user_data_123');

        expect(globalThis.fetch).toHaveBeenCalledWith('https://primary.com/real_user', expect.any(Request));
        expect(ctx.waitUntil).toHaveBeenCalled();
    });

    it('should failover to backup server if primary returns an error', async () => {
        const request = new Request('https://worker.local/real_user');

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Internal Error' }))
            .mockResolvedValueOnce(new Response('backup_data', { status: 200, statusText: 'OK' }));

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('backup_data');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should failover to backup server if primary returns an empty body', async () => {
        const request = new Request('https://worker.local/real_user');

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('   ', { status: 200, statusText: 'OK' }))
            .mockResolvedValueOnce(new Response('valid_backup_data', { status: 200, statusText: 'OK' }));

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('valid_backup_data');
    });

    it('should catch network-level exceptions and apply fallback (Lines 117-120)', async () => {
        const request = new Request('https://worker.local/real_user');

        // Force primary to simulate a DNS failure or generic TypeError, backup recovers
        vi.spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(new Response('backup_recovered', { status: 200 }));

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('backup_recovered');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should return last upstream error if all servers fail', async () => {
        const request = new Request('https://worker.local/real_user');

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', { status: 502, statusText: 'Bad Gateway' }))
            .mockResolvedValueOnce(new Response('', { status: 504, statusText: 'Gateway Timeout' }));

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(504);
        expect(response.headers.get('status-message')).toContain('Upstream error from https://backup.com');
    });

    it('should gracefully handle malformed USER_MAP in environment variables', async () => {
        const request = new Request('https://worker.local/real_user');

        // Sabotage env parsing parameters dynamically to force a fatal execution error
        // e.g., mapping properties to cause a native runtime error during application
        env.USER_MAP = '{"name": "John","age": 30,}'; // Malformed JSON with trailing comma will throw an error when line 24 attempts `JSON.parse(env.USER_MAP)`

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(500);
        expect(response.headers.get('status-message')).toContain('Worker error');
    });

    describe('Worker User Ban / ACL Tests', () => {
        let env;

        beforeEach(() => {
            env = {
                BASE_URL: '["https://primary.com/%s", "https://backup.com/%s"]',
                USER_MAP: '{"alias": "real_user"}',
                USER_BAN: '["!deploy*", "root", "*", "!admin"]',
            };

            if (globalThis.fetch && globalThis.fetch.mockClear) {
                globalThis.fetch.mockClear();
            }
        });

        it('should return 403 Forbidden if user is banned by exact match (root)', async () => {
            const request = new Request('https://worker.local/root');
            const response = await worker.fetch(request, env, ctx);

            expect(response.status).toBe(403);
            expect(response.headers.get('status-message')).toContain('banned');
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('should return 403 Forbidden if user falls into fallback ban (*)', async () => {
            const request = new Request('https://worker.local/random_user');
            const response = await worker.fetch(request, env, ctx);

            expect(response.status).toBe(403);
            expect(response.headers.get('status-message')).toContain('banned');
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('should allow user if matched by an allow prefix (!deploy*)', async () => {
            const request = new Request('https://worker.local/deploy-bot');
            const response = await worker.fetch(request, env, ctx);

            expect(response.status).not.toBe(403);
            expect(globalThis.fetch).toHaveBeenCalled();
        });

        it('should allow user if matched exactly by allow prefix (!deploy)', async () => {
            const request = new Request('https://worker.local/deploy');
            const response = await worker.fetch(request, env, ctx);

            expect(response.status).not.toBe(403);
            expect(globalThis.fetch).toHaveBeenCalled();
        });

        it('should return 403 Forbidden for admin because it is placed after the fallback wildcard', async () => {
            const request = new Request('https://worker.local/admin');
            const response = await worker.fetch(request, env, ctx);

            expect(response.status).toBe(403);
            expect(response.headers.get('status-message')).toContain('banned');
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('should allow access if USER_BAN array is empty', async () => {
            env.USER_BAN = '[]';
            const request = new Request('https://worker.local/any_user');
            const response = await worker.fetch(request, env, ctx);

            expect(response.status).not.toBe(403);
            expect(globalThis.fetch).toHaveBeenCalled();
        });
    });
});
