---
sidebar_position: 9
title: "CORS"
---

# CORS (Cross-Origin Resource Sharing)

CORS configuration enables web browsers to make cross-origin requests to your Neolith buckets. This is essential for browser-based applications that access object storage directly.

## How CORS Works in Neolith

- CORS configuration is per-bucket
- Configuration is stored as a `.cors.json` sidecar file in the bucket directory
- An `RwLock` cache in `AppState` avoids re-reading the sidecar on every request
- `OPTIONS` preflight requests **bypass authentication**, matching AWS S3 behavior
- CORS middleware runs after authentication in the middleware stack

## PutBucketCors

Sets the CORS configuration for a bucket.

**Request:**

```
PUT /<bucket>?cors HTTP/1.1
Host: localhost:9000
Content-Type: application/xml

<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>https://app.example.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-request-id</ExposeHeader>
    <ExposeHeader>x-amz-id-2</ExposeHeader>
  </CORSRule>
</CORSConfiguration>
```

**AWS CLI:**

```bash
# Create CORS configuration file
cat > cors.json << 'EOF'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.example.com"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600,
      "ExposeHeaders": ["ETag", "x-amz-request-id"]
    },
    {
      "AllowedOrigins": ["https://admin.example.com"],
      "AllowedMethods": ["GET"],
      "AllowedHeaders": ["Authorization"],
      "MaxAgeSeconds": 86400,
      "ExposeHeaders": []
    }
  ]
}
EOF

# Apply CORS configuration
aws --endpoint-url http://localhost:9000 s3api put-bucket-cors \
  --bucket my-bucket \
  --cors-configuration file://cors.json
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H "Content-Type: application/xml" \
  -d '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>' \
  "http://localhost:9000/my-bucket?cors"
```

**Response:** `200 OK` with empty body.

## GetBucketCors

Retrieves the CORS configuration for a bucket.

**Request:**

```
GET /<bucket>?cors HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api get-bucket-cors \
  --bucket my-bucket
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  "http://localhost:9000/my-bucket?cors"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>https://app.example.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-request-id</ExposeHeader>
  </CORSRule>
</CORSConfiguration>
```

If no CORS configuration exists, returns `404 NoSuchCORSConfiguration`.

## DeleteBucketCors

Removes the CORS configuration from a bucket.

**Request:**

```
DELETE /<bucket>?cors HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api delete-bucket-cors \
  --bucket my-bucket
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X DELETE \
  "http://localhost:9000/my-bucket?cors"
```

**Response:** `204 No Content` on success.

## CORS Rule Fields

| Field | Description | Required |
|---|---|---|
| `AllowedOrigin` | Origins allowed to make cross-origin requests. Use `*` for any origin. | Yes |
| `AllowedMethod` | HTTP methods allowed (`GET`, `PUT`, `POST`, `DELETE`, `HEAD`). | Yes |
| `AllowedHeader` | Headers allowed in the actual request. Use `*` to allow all. | No |
| `MaxAgeSeconds` | Time in seconds the browser caches the preflight response. | No |
| `ExposeHeader` | Response headers exposed to the browser JavaScript. | No |

## Preflight Requests (OPTIONS)

When a browser makes a cross-origin request, it first sends an `OPTIONS` preflight request. Neolith handles these without requiring authentication:

**Request:**

```
OPTIONS /<bucket>/<key> HTTP/1.1
Host: localhost:9000
Origin: https://app.example.com
Access-Control-Request-Method: PUT
Access-Control-Request-Headers: Content-Type, Authorization
```

**Response (200 OK):**

```
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET, PUT, POST, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 3600
Access-Control-Expose-Headers: ETag, x-amz-request-id
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
```

If the origin does not match any CORS rule, the preflight response omits the `Access-Control-Allow-*` headers and the browser blocks the request.

## Actual Request CORS Headers

On actual (non-preflight) requests, Neolith adds CORS headers if the request's `Origin` header matches a configured rule:

```
GET /my-bucket/data.json HTTP/1.1
Host: localhost:9000
Origin: https://app.example.com
Authorization: AWS4-HMAC-SHA256 ...
```

```
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Expose-Headers: ETag, x-amz-request-id
Vary: Origin
Content-Type: application/json
...
```

## Common Configurations

### Allow All Origins (Development)

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600,
      "ExposeHeaders": ["ETag", "x-amz-request-id", "x-amz-id-2"]
    }
  ]
}
```

### Read-Only Public Access

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Authorization", "Range"],
      "MaxAgeSeconds": 86400,
      "ExposeHeaders": ["Content-Length", "Content-Type", "ETag"]
    }
  ]
}
```

### Multiple Specific Origins

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "https://app.example.com",
        "https://staging.example.com"
      ],
      "AllowedMethods": ["GET", "PUT", "DELETE"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600,
      "ExposeHeaders": ["ETag"]
    }
  ]
}
```

## Storage

CORS configuration is stored as a `.cors.json` sidecar file:

```
<data-root>/<bucket>/
  .cors.json          # CORS rules
  .lifecycle.json     # Lifecycle rules
  .versioning.json    # Versioning state
```

The in-memory `RwLock` cache ensures that CORS evaluation does not require disk I/O on every request.
