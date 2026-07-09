---
sidebar_position: 2
title: "S3 Commands"
sidebar_label: "S3 Commands"
---

# S3 commands

These commands cover the standard S3 surface and work against any S3-compatible endpoint. Targets are written as `<alias>/<bucket>/<key>`, where `<alias>` is a configured endpoint (see [Configuration](configuration.md)). Every command also accepts the [global flags](overview.md#global-flags).

## neo alias

Manage named endpoint aliases (URL plus credentials). Aliases are stored in `~/.config/neo/config.toml`.

```bash
neo alias set <name> <url> <access-key> <secret-key> [--region us-east-1] [--addressing path|vhost]
neo alias ls
neo alias show <name>    # prints URL and region; the secret key is redacted
neo alias rm <name>
```

```bash
# Local Neolith dev server
neo alias set local https://localhost:9000 <access-key> <secret-key> --region us-east-1

# Production cluster with virtual-hosted-style addressing
neo alias set prod https://s3.example.com <access-key> <secret-key> --addressing vhost
```

## neo cp

Copy files or objects between local paths and Neolith. Uploads stream with a SigV4 PUT and switch to multipart automatically for large objects. Directory copies and multipart parts run in parallel.

```bash
neo cp <source> <destination>
```

| Flag | Description |
|---|---|
| `-r`, `--recursive` | Recurse into directories |
| `--part-size <BYTES>` | Override the multipart part size |
| `--concurrency <N>` | Parallel parts and file copies (default: 8) |
| `-q`, `--quiet` | Suppress progress output |

```bash
neo cp ./train.parquet local/datasets/train.parquet        # upload
neo cp local/datasets/train.parquet ./local-copy.parquet   # download
neo cp -r ./data/ local/datasets/                          # upload a directory
```

## neo ls

List buckets, or objects under a prefix. Pagination is automatic.

```bash
neo ls [<alias>[/<bucket>[/<prefix>]]]
```

| Flag | Description |
|---|---|
| `-r`, `--recursive` | Recurse below the prefix (the default delimits on `/`) |
| `--versions` | Show all object versions (requires a versioning-enabled bucket) |
| `--page-size <N>` | Maximum keys fetched per page (default: 1000) |

```bash
neo ls local                     # list all buckets
neo ls local/my-bucket           # list objects
neo ls local/my-bucket/data/     # list under a prefix
```

## neo mb / neo rb

Make or remove a bucket.

```bash
neo mb <alias>/<bucket> [--region <REGION>]
neo rb <alias>/<bucket> [--force]
```

`--region` sets the `LocationConstraint` on the new bucket. `neo rb` requires the bucket to be empty unless `--force` is given, which clears every object first and then deletes the bucket.

## neo rm

Remove an object, or every object under a prefix. Deletes are batched (up to 1000 keys per request).

```bash
neo rm <alias>/<bucket>/<key>
neo rm -r <alias>/<bucket>/<prefix>
```

| Flag | Description |
|---|---|
| `-r`, `--recursive` | Remove every object under the prefix |
| `--dry-run` | Show what would be deleted without deleting |
| `--concurrency <N>` | Concurrent DELETE requests when `-r` (default: 16) |

## neo stat

Show metadata for a bucket or object (an S3 HEAD). Prints all response headers.

```bash
neo stat <alias>/<bucket>[/<key>] [--version-id <ID>]
```

`--version-id` resolves a specific object version.

## neo sync

Sync a local directory tree to or from a bucket, or between two buckets. By default objects are compared by size; `--checksum` adds a content diff.

```bash
neo sync <source> <destination>
```

| Flag | Description |
|---|---|
| `--delete` | Delete destination objects not present in the source (mirror mode) |
| `--checksum` | Compare contents with a BLAKE3-128 hash when sizes match |
| `--concurrency <N>` | Parallel transfers (default: 16) |
| `--dry-run` | Print actions instead of executing them |

`--checksum` is skipped automatically for multipart objects, whose ETag carries a part-count suffix that cannot be reproduced locally. For remote-to-remote sync, `--checksum` compares remote ETags directly rather than hashing content.

```bash
neo sync ./data/ local/datasets/data/                    # local to remote
neo sync local/datasets/data/ ./local-mirror/            # remote to local
neo sync local/src-bucket/ local/dst-bucket/ --delete    # mirror one bucket to another
```

## neo presign

Generate a presigned SigV4 query-string URL for an object.

```bash
neo presign <alias>/<bucket>/<key> [--method GET] [--expires 3600]
```

`--expires` is in seconds (default 3600, AWS maximum 7 days). `--method` sets the HTTP verb the URL authorizes (default `GET`).

## neo completions

Print a shell completion script to stdout for `bash`, `zsh`, `fish`, `elvish`, or `powershell`.

```bash
# bash
neo completions bash >> ~/.bashrc

# zsh
neo completions zsh > ~/.zfunc/_neo
echo 'fpath+=~/.zfunc' >> ~/.zshrc && compinit

# fish
neo completions fish > ~/.config/fish/completions/neo.fish
```
