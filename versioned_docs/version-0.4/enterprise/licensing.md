---
sidebar_position: 9
title: "Licensing"
---

# Licensing

Neolith Enterprise uses Ed25519 digital signatures for offline license validation. Licenses are self-contained files that encode the edition, feature set, expiry date, and capacity limits. No license server or network call is required for validation.

## License Architecture

The `neolith-license` crate implements the complete licensing subsystem:

```
License File (.key)
┌───────────────────────────┐
│ License Payload (JSON)    │
│ ┌───────────────────────┐ │
│ │ license_id            │ │
│ │ edition               │ │
│ │ features              │ │
│ │ issued_at             │ │
│ │ expires_at            │ │
│ │ max_nodes             │ │
│ │ max_storage_bytes     │ │
│ │ licensee              │ │
│ └───────────────────────┘ │
│                           │
│ Ed25519 Signature (64B)   │
└───────────────────────────┘
```

## License Fields

| Field | Type | Description |
|---|---|---|
| `license_id` | UUID | Unique identifier for this license |
| `edition` | String | `enterprise` or `ai` |
| `features` | Vec\<String\> | Enabled feature flags (e.g., `multi_tenancy`, `replication`, `compliance`) |
| `issued_at` | DateTime | When the license was issued |
| `expires_at` | DateTime | When the license expires |
| `max_nodes` | u32 | Maximum cluster size (0 = unlimited) |
| `max_storage_bytes` | u64 | Maximum aggregate storage (0 = unlimited) |
| `licensee` | String | Organization name |
| `licensee_email` | String | Contact email |

## Ed25519 Offline Validation

License validation uses Ed25519 public-key cryptography:

1. **Signing (at license generation time)**: The license payload is serialized to canonical JSON and signed with Anthropic's Ed25519 private key. The signature (64 bytes) is appended to the license file.
2. **Validation (at startup)**: The Neolith binary contains the embedded Ed25519 public key. At startup, it reads the license file, verifies the signature against the public key, and checks the expiry date.

```
Signing (offline, license generation):
  payload_json = canonicalize(license_payload)
  signature = ed25519_sign(private_key, payload_json)
  license_file = base64(payload_json || signature)

Validation (at Neolith startup):
  (payload_json, signature) = decode(license_file)
  valid = ed25519_verify(public_key, payload_json, signature)
  expired = payload.expires_at < now()
```

No network call, no license server, no phone-home. The validation is purely cryptographic and runs in microseconds.

## 14-Day Grace Period

When no valid license is present, Neolith Enterprise enters a 14-day grace period:

| Day | Behavior |
|---|---|
| 1-7 | Full Enterprise functionality. Warning log message at startup. |
| 8-14 | Full Enterprise functionality. Warning log message at startup and every hour. |
| 15+ | Enterprise features are disabled. Server falls back to OSS mode. Existing data remains accessible. |

The grace period enables evaluation without requiring a license file and provides a buffer for license renewal:

```
Startup log (grace period active):

  ┌─────────────────────────────────────────────────────────────┐
  │  NEOLITH ENTERPRISE - EVALUATION MODE                       │
  │                                                             │
  │  No valid license found. Enterprise features are available  │
  │  for 14 days from first activation.                        │
  │                                                             │
  │  Days remaining: 11                                        │
  │  First activated: 2026-03-06T10:00:00Z                     │
  │                                                             │
  │  To obtain a license, visit:                               │
  │  https://neolith.dev/enterprise                            │
  └─────────────────────────────────────────────────────────────┘
```

The grace period start time is recorded in `.neolith/grace_period.json` (persisted to disk). If the file is deleted, the grace period restarts, but the audit log records this event.

## License Checking at Startup

The startup sequence for license validation:

```
1. Read NEOLITH_EDITION env var (or config.edition)
   └─> If "oss": skip license check, run in OSS mode

2. Look for license file:
   - --license CLI flag
   - NEOLITH_LICENSE_FILE env var
   - /etc/neolith/license.key (default path)
   └─> If not found: enter grace period

3. Validate license:
   a. Decode base64
   b. Separate payload and signature
   c. Verify Ed25519 signature against embedded public key
   d. Parse payload JSON
   └─> If invalid signature: reject, fall back to OSS

4. Check license fields:
   a. edition matches or exceeds NEOLITH_EDITION
   b. expires_at > now()
   c. max_nodes >= current cluster size
   d. max_storage_bytes >= current storage usage
   └─> If expired: enter grace period (if within 14 days of expiry)
   └─> If capacity exceeded: warning log, allow startup

5. Enable licensed features:
   - Set global Edition enum
   - Register enabled feature flags
   - Log license details (licensee, expiry, limits)
```

## Development Keypair

For development and testing, a dev keypair is included in the `keys/` directory of the enterprise repository:

```
keys/
  dev-private.key   # Ed25519 private key (DO NOT use in production)
  dev-public.key    # Ed25519 public key (embedded in dev builds)
```

The dev keypair is used to generate test licenses during development. Production builds embed a different public key that only accepts licenses signed by the production private key (held securely offline).

```bash
# Generate a dev license (for testing only)
cargo run --bin neolith-license-gen -- \
  --edition enterprise \
  --licensee "Development" \
  --expires-in-days 365 \
  --max-nodes 0 \
  --private-key keys/dev-private.key \
  --output dev-license.key
```

## Feature Gating

Individual Enterprise features are gated by the license's `features` list. This enables fine-grained licensing: a customer can purchase compliance features without replication, or multi-tenancy without the web console.

```rust
// Feature check in code
if !license.has_feature("multi_tenancy") {
    check_and_print_upsell("Multi-Tenancy", Edition::Enterprise);
    return Err(NeolithError::FeatureNotLicensed("multi_tenancy"));
}
```

The `check_and_print_upsell()` function prints an ASCII-boxed message to stderr with the feature name, required edition, and a URL to learn more. This ensures operators always understand why a feature is unavailable.

## License Renewal

License renewal is straightforward:
1. Obtain a new license file from the Neolith Enterprise portal.
2. Replace the existing license file on disk.
3. Restart the Neolith server (or send SIGHUP for hot-reload in a future version).

The new license is validated at startup using the same Ed25519 verification. If the new license is valid and not expired, Enterprise features are re-enabled immediately.
