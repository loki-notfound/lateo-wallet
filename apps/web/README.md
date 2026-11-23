# Lateo Wallet — Web PWA (`@lateo-wallet/web`)

Installable Progressive Web App for Lateo Wallet (`https://wallet.lateo.dev`), reusing `@lateo-wallet/core` and `@lateo-wallet/ui` with origin IndexedDB vault persistence, in-tab Web Worker execution (`proxyToWorker: true`), idle auto-lock, and `beforeunload` save-barrier protection.

## Build & Local Verification

```bash
corepack pnpm build:web
corepack pnpm verify:web
```

`corepack pnpm build:web` emits a static, zero-sourcemap bundle under `apps/web/dist/` containing:
- `index.html`, `manifest.webmanifest`, and vendored PWA icons (`favicon.svg`, `favicon-32.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`)
- External CSS stylesheet bundle (zero runtime `<style>` injection, zero inline `style=` attributes)
- Deduplicated `assets/zephyr-<hash>.wasm` and `assets/zephyr.worker-<hash>.js`

## Security Requirements & HTTP Response Headers

The web app MUST be served over `https://` (or `http://localhost` / `http://127.0.0.1` for local development) so `crypto.subtle` is available for vault encryption and `zephyr.wasm` SHA-256 self-integrity verification.

### 1. Document Content-Security-Policy (HTML & Static Pages)

Serve the HTML document with the following strict CSP header (note that `index.html` also embeds a baseline `<meta http-equiv="Content-Security-Policy">` fallback, while HTTP headers are required for `frame-ancestors 'none'` and dedicated Worker CSP):

```text
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Also send standard defensive headers on all responses:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

### 2. Dedicated Worker Content-Security-Policy (Required for Firefox)

Dedicated Web Workers do **not** inherit the document CSP. Firefox requires `'wasm-unsafe-eval'` in the CSP header of the `zephyr.worker-*.js` response itself so the page can transfer the compiled `WebAssembly.Module` into the worker; without it, Firefox blocks worker instantiation with `WASM_MODULE_REJECTED`.

Serve `assets/zephyr.worker-*.js` with its own explicit CSP header:

```text
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*
```

Ensure `assets/zephyr-*.wasm` is served with `Content-Type: application/wasm` and that HTML (`index.html`) uses `Cache-Control: no-cache` while hashed `/assets/*` files use immutable caching so browsers never mix stale `zephyr.wasm` bytes with newer JS bundles.

## Same-Origin `/rpc` Reverse Proxy

By default on HTTPS origins (e.g. `https://wallet.lateo.dev`), Lateo Wallet targets `${origin}/rpc` so daemon RPC traffic stays same-origin and avoids browser CORS restrictions. Users can also switch to `https://node.lateo.dev` or any custom CORS-enabled HTTPS (or localhost HTTP) node in Settings.

Forward only allowlisted restricted Zephyr daemon RPC paths (`POST`/`GET`) under `/rpc/*` without HTTP redirects, without chunked request transfer encoding, without forwarding client IP or credential headers (`X-Forwarded-For`, `X-Real-IP`, `Cookie`, `Authorization`), and with `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS on every `/rpc/` response.

### Caddy Example

```caddyfile
wallet.lateo.dev {
	root * /srv/lateo-wallet/dist

	# Same-origin restricted RPC reverse proxy (allowlisted paths & GET/POST only)
	handle /rpc/* {
		header {
			Content-Security-Policy "default-src 'none'; frame-ancestors 'none'"
			X-Content-Type-Options "nosniff"
			Referrer-Policy "no-referrer"
			Strict-Transport-Security "max-age=63072000; includeSubDomains"
			Cache-Control "no-store"
		}

		@rpcBadMethod not method GET POST
		respond @rpcBadMethod 405

		@rpcAllowed path_regexp rpc ^/rpc/(?:json_rpc|getblocks\.bin|get_o_indexes\.bin|get_?outs\.bin|get_?transactions|sendrawtransaction|get_?height|get_info)$
		handle @rpcAllowed {
			uri strip_prefix /rpc
			reverse_proxy https://node.lateo.dev {
				header_up Host node.lateo.dev
				header_up -X-Forwarded-For
				header_up -X-Real-IP
				header_up -Cookie
				header_up -Authorization
				transport http {
					read_timeout 120s
					write_timeout 120s
				}
			}
		}

		respond 404
	}

	# Dedicated worker CSP (required by Firefox for WASM in workers)
	@worker path_regexp worker ^/assets/zephyr\.worker-[A-Za-z0-9_-]+\.js$
	header @worker {
		Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		Cache-Control "public, max-age=31536000, immutable"
	}

	# Document & static assets CSP
	@notWorker {
		not path /rpc/*
		not path_regexp worker ^/assets/zephyr\.worker-[A-Za-z0-9_-]+\.js$
	}
	header @notWorker {
		Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
	}

	@html path / /index.html
	header @html Cache-Control "no-cache"

	file_server
}
```

### Nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name wallet.lateo.dev;

    root /srv/lateo-wallet/dist;
    index index.html;

    # Same-origin restricted RPC reverse proxy (allowlisted wallet paths & GET/POST only)
    location ~ ^/rpc/(?:json_rpc|getblocks\.bin|get_o_indexes\.bin|get_?outs\.bin|get_?transactions|sendrawtransaction|get_?height|get_info)$ {
        limit_except GET POST {
            deny all;
        }
        rewrite ^/rpc/(.*)$ /$1 break;
        proxy_pass https://node.lateo.dev;
        proxy_ssl_server_name on;
        proxy_set_header Host node.lateo.dev;
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_http_version 1.1;
        proxy_request_buffering on;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        client_max_body_size 4m;
        add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Cache-Control "no-store" always;
    }

    location ^~ /rpc/ {
        add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Cache-Control "no-store" always;
        return 404;
    }

    # Dedicated worker CSP (required by Firefox for WASM in workers)
    location ~ ^/assets/zephyr\.worker-[A-Za-z0-9_-]+\.js$ {
        add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    location /assets/ {
        add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    location / {
        add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Cache-Control "no-cache" always;
        try_files $uri /index.html;
    }
}
```
