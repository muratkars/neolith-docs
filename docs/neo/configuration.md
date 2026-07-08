---
sidebar_position: 4
title: "Configuration"
sidebar_label: "Configuration"
---

# Configuration

`neo` reads its endpoints and credentials from a TOML config file, by default `~/.config/neo/config.toml`. You normally never edit it by hand: `neo alias set` writes it for you with an atomic temp-and-rename.

## Aliases

An alias is a named endpoint: a URL, a credential pair, a region, and an addressing style. The alias name is the first path segment of every target (`local/my-bucket/key`).

```bash
neo alias set local https://localhost:9000 <access-key> <secret-key> --region us-east-1
neo alias ls
neo alias show local    # URL and region only; the secret key is redacted
neo alias rm local
```

## Profiles

The active alias is the configured `default`. Override it per invocation with `--profile <name>` (short form `-p`) or the `NEO_PROFILE` environment variable:

```bash
neo ls --profile prod
NEO_PROFILE=prod neo ls
```

## Addressing style

`--addressing` selects how the bucket is placed in the request URL:

- `path` (default): `https://endpoint/<bucket>/<key>`. Works everywhere and is the right choice for local and self-hosted Neolith.
- `vhost`: `https://<bucket>.endpoint/<key>`. Virtual-hosted-style, for endpoints served under a wildcard DNS name.

## Config file reference

```toml
default = "local"

[aliases.local]
url = "https://localhost:9000"
access_key = "AKIAIOSFODNN7EXAMPLE"
secret_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
region = "us-east-1"
addressing = "path"     # "path" (default) or "vhost"

[aliases.prod]
url = "https://s3.example.com"
access_key = "AKIA..."
secret_key = "..."
region = "us-east-1"
addressing = "vhost"
```

Use `--config <path>` to point `neo` at a config file elsewhere, for example when isolating credentials per project or in CI.

## TLS and self-signed certificates

`neo` accepts self-signed certificates so a local Neolith dev server over HTTPS works out of the box. Production endpoints use valid certificates, so this is transparent there.
