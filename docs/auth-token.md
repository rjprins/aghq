# Auth Token (Opt-in)

agmux token auth is optional.

## Default behavior

- If `AGMUX_TOKEN_ENABLED` is **unset** (or falsey), auth is disabled.
- `/api/*` and `/ws` are accessible without a token (still bound to loopback by default).

## Enable token auth

Enable auth explicitly:

```sh
AGMUX_TOKEN_ENABLED=1 npm run app
```

Optional: provide a fixed token:

```sh
AGMUX_TOKEN_ENABLED=1 AGMUX_TOKEN=my-secret-token npm run app
```

When enabled:

- `/api/*` requires token auth
- `/ws` requires token auth
- accepted token formats:
  - header: `x-agmux-token: <token>`
  - header: `Authorization: Bearer <token>`
  - query: `?token=<token>`
- token source:
  - `AGMUX_TOKEN` set: uses configured token
  - `AGMUX_TOKEN` unset: generates a random token at startup

## Browser auto-open behavior

When token auth is enabled (`AGMUX_TOKEN_ENABLED=1`) and `AGMUX_NO_OPEN` is not set to `1`, agmux auto-opens:

```text
http://127.0.0.1:<port>/?token=<token>
```

So the UI can start immediately without a manual token prompt.

The UI keeps `?token=...` in the URL so refreshes remain authenticated even if web storage is unavailable.

## Startup logging

On startup, agmux logs:

- whether token auth is enabled or disabled
- the configured log level
- the token value and tokenized URL (when auth is enabled)

## Log verbosity

Default log level is `warn` to reduce noise.

Override with:

```sh
AGMUX_LOG_LEVEL=info npm run app
```
