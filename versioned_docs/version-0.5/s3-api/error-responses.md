---
sidebar_position: 13
title: "Error Responses"
---

# Error Responses

When a request fails, Neolith returns an XML error response body with an appropriate HTTP status code. Every error response includes the `x-amz-request-id` header for tracing.

## Error Response Format

All error responses follow the standard S3 XML error format:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>missing-file.txt</Key>
  <BucketName>my-bucket</BucketName>
  <RequestId>550e8400-e29b-41d4-a716-446655440000</RequestId>
</Error>
```

### Response Headers

Every error response includes:

```
HTTP/1.1 404 Not Found
Content-Type: application/xml
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000
x-amz-id-2: neolith
```

## Error Codes Reference

### Client Errors (4xx)

| Code | HTTP Status | Description |
|---|---|---|
| `AccessDenied` | 403 | Access to the resource is denied. Invalid credentials or insufficient permissions. |
| `BadDigest` | 400 | The Content-MD5 header did not match the body digest. |
| `BucketAlreadyExists` | 409 | The requested bucket name is already in use. |
| `BucketNotEmpty` | 409 | The bucket you tried to delete is not empty. |
| `EntityTooLarge` | 400 | The object exceeds the maximum allowed size (128 MiB for single PUT). |
| `EntityTooSmall` | 400 | A multipart upload part is smaller than the 5 MiB minimum. |
| `ExpiredToken` | 400 | The provided security token has expired. |
| `IncompleteBody` | 400 | The request body did not contain the expected number of bytes. |
| `InvalidArgument` | 400 | An argument to the operation is invalid (e.g., control characters in key). |
| `InvalidBucketName` | 400 | The bucket name does not conform to naming rules. |
| `InvalidDigest` | 400 | The Content-MD5 header is not valid base64. |
| `InvalidPart` | 400 | A part specified in CompleteMultipartUpload was not uploaded. |
| `InvalidPartOrder` | 400 | Parts in CompleteMultipartUpload are not in ascending order. |
| `InvalidRange` | 416 | The requested range is not satisfiable. |
| `InvalidRequest` | 400 | The request is not valid for the current state of the resource. |
| `InvalidTag` | 400 | The tag set is invalid (too many tags, key/value too long, duplicate keys). |
| `KeyTooLongError` | 400 | The object key is too long. |
| `MalformedXML` | 400 | The XML provided was not well-formed or did not match the expected schema. |
| `MaxMessageLengthExceeded` | 400 | The request body exceeds the configured maximum. |
| `MethodNotAllowed` | 405 | The specified method is not allowed against this resource. |
| `MissingContentLength` | 411 | Content-Length header is required but was not provided. |
| `MissingSecurityHeader` | 400 | A required security header (e.g., SSE-C key) is missing. |
| `NoSuchBucket` | 404 | The specified bucket does not exist. |
| `NoSuchCORSConfiguration` | 404 | The bucket does not have a CORS configuration. |
| `NoSuchKey` | 404 | The specified key does not exist. |
| `NoSuchLifecycleConfiguration` | 404 | The bucket does not have a lifecycle configuration. |
| `NoSuchUpload` | 404 | The specified multipart upload ID does not exist (may have expired). |
| `NoSuchVersion` | 404 | The specified version ID does not exist. |
| `PreconditionFailed` | 412 | A condition specified in the request (If-Match, If-Unmodified-Since) was not met. |
| `NotModified` | 304 | The object has not been modified (If-None-Match, If-Modified-Since). |
| `SignatureDoesNotMatch` | 403 | The provided SigV4 signature does not match the expected value. |
| `TooManyParts` | 400 | The multipart upload exceeds the maximum 10,000 parts. |
| `AuthorizationQueryParametersError` | 400 | Invalid presigned URL parameters (e.g., X-Amz-Expires > 604800). |

### Server Errors (5xx)

| Code | HTTP Status | Description |
|---|---|---|
| `InternalError` | 500 | An internal server error occurred. |
| `InsufficientStorage` | 507 | The server does not have enough storage to complete the request (disk full). |
| `ServiceUnavailable` | 503 | The server is temporarily unable to handle the request (overloaded or split-brain). |

## Error Examples

### NoSuchBucket

```bash
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket nonexistent-bucket \
  --key file.txt \
  output.txt
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchBucket</Code>
  <Message>The specified bucket does not exist.</Message>
  <BucketName>nonexistent-bucket</BucketName>
  <RequestId>660f9500-f39c-52e5-b827-557766551111</RequestId>
</Error>
```

### NoSuchKey

```bash
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key does-not-exist.txt \
  output.txt
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>does-not-exist.txt</Key>
  <BucketName>my-bucket</BucketName>
  <RequestId>770a0600-a40d-63f6-c938-668877662222</RequestId>
</Error>
```

### AccessDenied (Invalid Credentials)

```bash
AWS_ACCESS_KEY_ID=wrong AWS_SECRET_ACCESS_KEY=wrong \
aws --endpoint-url http://localhost:9000 s3api list-buckets
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>AccessDenied</Code>
  <Message>Access Denied</Message>
  <RequestId>880b1700-b51e-74g7-da49-779988773333</RequestId>
</Error>
```

### SignatureDoesNotMatch

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>SignatureDoesNotMatch</Code>
  <Message>The request signature we calculated does not match the signature you provided.</Message>
  <RequestId>990c2800-c62f-85h8-eb50-880099884444</RequestId>
</Error>
```

### BadDigest (Content-MD5 Mismatch)

```bash
# Upload with incorrect Content-MD5
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H "Content-MD5: aW52YWxpZA==" \
  -d "Hello, Neolith!" \
  http://localhost:9000/my-bucket/test.txt
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>BadDigest</Code>
  <Message>The Content-MD5 you specified did not match what we received.</Message>
  <RequestId>aa0d3900-d73g-96i9-fc61-991100995555</RequestId>
</Error>
```

### EntityTooSmall (Multipart Part Too Small)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>EntityTooSmall</Code>
  <Message>Your proposed upload is smaller than the minimum allowed object size. Each part must be at least 5 MiB.</Message>
  <RequestId>bb1e4a00-e84h-a7j0-gd72-aa2211006666</RequestId>
</Error>
```

### InsufficientStorage (Disk Full)

Neolith performs a pre-write `statvfs` check (1 MB reserve). If the disk is too full, or if an `ENOSPC` error occurs during the write, the server returns:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>InsufficientStorage</Code>
  <Message>There is not enough storage space to complete the request.</Message>
  <RequestId>cc2f5b00-f95i-b8k1-he83-bb3322117777</RequestId>
</Error>
```

HTTP Status: `507 Insufficient Storage`

### PreconditionFailed

```bash
# Conditional PUT that fails
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X GET \
  -H 'If-Match: "wrongetag"' \
  http://localhost:9000/my-bucket/data.json
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>PreconditionFailed</Code>
  <Message>At least one of the pre-conditions you specified did not hold.</Message>
  <RequestId>dd3g6c00-g06j-c9l2-if94-cc4433228888</RequestId>
</Error>
```

## Error Handling in SDKs

### AWS CLI

The AWS CLI automatically parses S3 XML errors and displays them:

```
An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.
```

### Python (boto3)

```python
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client(
    's3',
    endpoint_url='http://localhost:9000',
    aws_access_key_id='myaccesskey',
    aws_secret_access_key='mysecretkey',
)

try:
    s3.get_object(Bucket='my-bucket', Key='missing.txt')
except ClientError as e:
    error_code = e.response['Error']['Code']
    error_message = e.response['Error']['Message']
    request_id = e.response['ResponseMetadata']['RequestId']
    print(f"Error {error_code}: {error_message} (RequestId: {request_id})")
```

### Go (AWS SDK v2)

```go
import (
    "errors"
    "github.com/aws/smithy-go"
)

_, err := client.GetObject(ctx, &s3.GetObjectInput{
    Bucket: aws.String("my-bucket"),
    Key:    aws.String("missing.txt"),
})
if err != nil {
    var apiErr smithy.APIError
    if errors.As(err, &apiErr) {
        fmt.Printf("Error %s: %s\n", apiErr.ErrorCode(), apiErr.ErrorMessage())
    }
}
```

### Rust (aws-sdk-s3)

```rust
use aws_sdk_s3::error::SdkError;

match client.get_object()
    .bucket("my-bucket")
    .key("missing.txt")
    .send()
    .await
{
    Ok(output) => { /* handle success */ }
    Err(SdkError::ServiceError(err)) => {
        eprintln!("Service error: {:?}", err.err());
    }
    Err(err) => {
        eprintln!("Other error: {:?}", err);
    }
}
```

## Implementation Notes

- Neolith's S3 layer uses its own `S3Error` type (not `NeolithError`) which converts directly to XML
- XML error bodies are built with `std::fmt::Write` (not `quick-xml`) to avoid clippy `format_push_string` warnings
- The `x-amz-request-id` is a UUID v4 assigned by the outermost request ID middleware, ensuring it is present even on errors that occur early in the middleware stack
- The `x-amz-id-2` header is always set to `neolith`
