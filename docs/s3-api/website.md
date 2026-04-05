---
sidebar_position: 10
title: "Static Website Hosting"
---

# Static Website Hosting

> **Status:** Planned for a future release. This feature is not yet implemented.

## Overview

Static website hosting will allow you to serve a bucket's contents as a static website, with configurable index and error documents.

## Planned Features

### Bucket Website Configuration

The following capabilities are planned:

- **Index document** - specify a default document (e.g., `index.html`) served when a request is made to the root or a directory path
- **Error document** - specify a custom error page (e.g., `error.html`) served when an object is not found
- **Redirect rules** - configure URL redirect rules for specific key prefixes or HTTP error codes
- **Website endpoint** - a dedicated endpoint that serves objects without requiring SigV4 authentication

### Planned API Operations

| Operation | Description |
|---|---|
| `PutBucketWebsite` | Configure website hosting for a bucket |
| `GetBucketWebsite` | Retrieve the website configuration |
| `DeleteBucketWebsite` | Remove website hosting configuration |

### Example Configuration (Planned)

```xml
<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IndexDocument>
    <Suffix>index.html</Suffix>
  </IndexDocument>
  <ErrorDocument>
    <Key>error.html</Key>
  </ErrorDocument>
  <RoutingRules>
    <RoutingRule>
      <Condition>
        <KeyPrefixEquals>docs/</KeyPrefixEquals>
      </Condition>
      <Redirect>
        <ReplaceKeyPrefixWith>documents/</ReplaceKeyPrefixWith>
      </Redirect>
    </RoutingRule>
  </RoutingRules>
</WebsiteConfiguration>
```

### AWS CLI (Planned)

```bash
# Enable website hosting
aws --endpoint-url http://localhost:9000 s3api put-bucket-website \
  --bucket my-website \
  --website-configuration '{
    "IndexDocument": {"Suffix": "index.html"},
    "ErrorDocument": {"Key": "error.html"}
  }'

# Upload website content
aws --endpoint-url http://localhost:9000 s3 sync ./build/ s3://my-website/

# Access via website endpoint
curl http://my-website.localhost:9000/
```

## Current Alternatives

While static website hosting is not yet available, you can serve static content from Neolith using:

1. **Presigned URLs** - generate time-limited public URLs for specific objects
2. **A reverse proxy** - place Nginx or Caddy in front of Neolith to handle SigV4 signing and serve content as a website
3. **Neolith Web Console** - the built-in admin console provides a browser-based interface for managing objects

## Tracking

This feature is tracked for implementation in a future release. Check the project roadmap for updates.
