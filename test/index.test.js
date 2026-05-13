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

    it('should return 403 Forbidden if user is banned', async () => {
        const request = new Request('https://worker.local/banned_user');

        const response = await worker.fetch(request, env, ctx);

        expect(response.status).toBe(403);
        expect(response.headers.get('status-message')).toContain('banned');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should correctly remap user according to USER_MAP', async () => {
        const request = new Request('https://worker.local/alias');

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('data', { status: 200 }));

        await worker.fetch(request, env, ctx);

        expect(globalThis.fetch).toHaveBeenCalledWith('https://primary.com/real_user', expect.any(Request));
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
});
