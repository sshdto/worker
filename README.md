# Cloudflare Worker for [sshd.to](https://gitlab.com/sshdto/sshdto)

**Smart Failover Proxy with Caching**

A robust, production-ready Cloudflare Worker that acts as a proxy to fetch data for users kpublic SSH key dynamically.

It features built-in username mapping, automated IP/user banning, multi-upstream failover capability (mirror backup switching), empty-body protection, and high-performance edge caching.

---

## Live Demo

You can try a live running instance of this worker at:
👉 **[https://keys.sshd.to/honza](https://keys.sshd.to/honza)**

_How to test it:_

- Accessing the URL path `/honza` will trigger the Worker to extract `honza` as the user.
- It will sequentially query the configured upstream mirrors.
- The first mirror to respond with a non-empty `200 OK` will have its response cached for 5 minutes and delivered to you instantly.

---

## Features

- **Multi-Upstream Failover:** Supply a single URL or a list of mirror URLs. If the primary server goes down, the Worker automatically tries the next one.
- **Cache Layer:** Successful responses are cached at Cloudflare's edge for 5 minutes, significantly reducing load on your upstream servers.
- **User Mapping:** Translate incoming request paths to customized upstream usernames.
- **Banning System:** Block malicious or unwanted users instantly at the edge before hitting your servers.
- **Empty-Response Protection:** If a server responds with `200 OK` but returns an empty body, the Worker treats it as a failure and tries the next mirror.

---

## How It Works

1. **Routing:** The Worker extracts the user identifier from the URL path (e.g., `https://your-worker.com/john_doe` -> user is `john_doe`).
2. **Mapping & Bans:** It checks if `john_doe` is mapped to another username or if they are banned.
   - Mapping: [honza](https://keys.sshd.to/honza) is mapped to [honzahommer](https://keys.sshd.to/honza)
   - Bans: [root](https://keys.sshd.to/root) is banned
3. **Cache Lookup:** It checks if the requested data for this user is already cached. If yes, it returns it instantly.
4. **Upstream Fetch:** If it's a cache miss, it loops through your defined `BASE_URL` targets, replaces `%s` with the username, and fetches the data.
5. **Caching & Delivery:** Upon a successful non-empty response, it saves the result to Cloudflare's cache for 5 minutes and returns the data to the client.

---

## Environment Variables (`env`)

Configure these variables via your Cloudflare Dashboard or inside your `wrangler.toml` file.

| Variable       | Type                            | Description                                                                                                                                                                    | Example                                                                                                    |
| :------------- | :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| **`BASE_URL`** | `String` (JSON Array or String) | **Required.** The target URL(s) to proxy. Must contain `%s` where the username should be injected. Can be a single string or a stringified JSON array for failover.            | `"https://api.primary.com/%s"` <br>or<br> `["https://api.primary.com/%s", "https://backup-mirror.com/%s"]` |
| **`USER_MAP`** | `String` (JSON Object)          | _Optional._ Maps the incoming URL slug to a different upstream username.                                                                                                       | `{"alias_name": "real_username"}`                                                                          |
| **`USER_BAN`** | `String` (JSON Array)           | _Optional._ A list of usernames or patterns forbidden from using the proxy. It evaluates rules from top to bottom and supports wildcards (`*`) and negation/allow rules (`!`). | `["!deploy*", "root", "*", "!admin"]`                                                                      |

---

## Troubleshooting & Logs

You can monitor performance, cache hits, and failover triggers in real time:

- Go to Cloudflare Dashboard -> Workers & Pages -> select your Worker -> Live Logs.
- The script uses `console.warn` prefixed with `[Failover]` to track when a secondary mirror had to be used, and `console.log` for `[Cache]` hits.
