export default {
    async fetch(request, env, ctx) {
        // Helper function for consistent and clean text responses
        const textResponse = (status, msg = '', body = '') =>
            new Response(body, {
                status,
                headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    ...(msg && { 'status-message': msg }),
                },
            });

        try {
            if (!env.BASE_URL) {
                return textResponse(422, 'BASE_URL is not defined in the environment variables.');
            }

            // Safely parse BASE_URL (can be a single string or a JSON array of strings)
            let baseURLs = [];
            try {
                const parsed = JSON.parse(env.BASE_URL);
                baseURLs = Array.isArray(parsed) ? parsed : [env.BASE_URL];
            } catch {
                baseURLs = [env.BASE_URL]; // Fallback to single string if not valid JSON
            }

            // Safely parse JSON configuration with fallbacks
            const userBan = typeof env.USER_BAN === 'string' ? JSON.parse(env.USER_BAN) : env.USER_BAN || [];
            const userMap = typeof env.USER_MAP === 'string' ? JSON.parse(env.USER_MAP) : env.USER_MAP || {};

            // Extract user from URL and apply mapping if exists
            const url = new URL(request.url);
            let user = url.pathname.slice(1);
            if (userMap[user]) {
                user = userMap[user];
            }

            // Check if the user is banned
            if (userBan.includes(user)) {
                return textResponse(403, `User "${user}" is banned from accessing the service.`);
            }

            // --- CACHE READ LAYER ---
            // Construct a unique cache key URL based on the final mapped user
            // This ensures different original URLs mapping to the same user share the cache
            const cacheUrl = new URL(request.url);
            cacheUrl.pathname = `/${user}`;
            const cacheKey = new Request(cacheUrl.toString(), request);

            const cache = caches.default; // eslint-disable-line no-undef
            const cachedResponse = await cache.match(cacheKey);

            if (cachedResponse) {
                console.log(`[Cache] Hit for user: ${user}`);
                return cachedResponse;
            }
            // ------------------------

            // Failover mechanism: try upstreams sequentially
            let lastErrorMsg = 'No upstream available';
            let lastStatus = 502;

            for (const baseURL of baseURLs) {
                const requestURL = baseURL.replace('%s', user);

                try {
                    // .clone() is required because the request body can only be read once during multiple fetch attempts
                    const response = await fetch(requestURL, request.clone());

                    if (response.ok) {
                        const text = await response.text();

                        // Check if the response body is empty
                        if (text && text.trim().length > 0) {
                            // Create the final successful response
                            const successResponse = textResponse(200, '', text);

                            // --- CACHE WRITE LAYER ---
                            // We must clone the response to modify headers and write to cache
                            const responseToCache = successResponse.clone();
                            // Overwrite/set Cache-Control to instruct Cloudflare to cache this for 5 minutes (300 seconds)
                            responseToCache.headers.set('Cache-Control', 'public, max-age=300');

                            // ctx.waitUntil ensures the worker doesn't terminate before the cache write finishes
                            ctx.waitUntil(cache.put(cacheKey, responseToCache));
                            // -------------------------

                            return successResponse;
                        }

                        lastStatus = 502;
                        lastErrorMsg = `Upstream ${baseURL} returned an empty response.`;
                        console.warn(`[Failover] Empty body from: ${requestURL}`);
                        continue;
                    }

                    // Handle non-2xx HTTP responses (e.g., 500, 404)
                    lastStatus = response.status;
                    lastErrorMsg = `Upstream error from ${baseURL}: ${response.status} ${response.statusText}`;
                    console.warn(`[Failover] HTTP ${response.status} from: ${requestURL}`);
                } catch (fetchErr) {
                    // Catch network errors (DNS failures, connection timeouts)
                    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                    lastStatus = 502;
                    lastErrorMsg = `Network error connecting to ${baseURL}: ${errMsg}`;
                    console.warn(`[Failover] Network error on: ${requestURL} - ${errMsg}`);
                }
            }

            // If the loop finished, all configured upstreams failed
            console.error(`[Failover Failed] All upstreams failed for user: ${user}`);
            return textResponse(lastStatus, lastErrorMsg);
        } catch (err) {
            console.error('[Worker Fatal Error]', err);
            const errMsg = err instanceof Error ? err.message : String(err);
            return textResponse(err.status || 500, `Worker error: ${errMsg}`);
        }
    },
};
