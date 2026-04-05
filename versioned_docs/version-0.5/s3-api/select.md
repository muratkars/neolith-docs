---
sidebar_position: 11
title: "S3 Select"
---

# S3 Select

> **Enterprise Feature** - S3 Select is available in Neolith Enterprise edition.

S3 Select allows you to retrieve a subset of data from an object using SQL expressions. Instead of downloading an entire object and filtering client-side, you push the query to the server and receive only the matching rows or fields.

## Overview

S3 Select reduces data transfer and speeds up analytics workloads by filtering data at the storage layer. Neolith Enterprise supports querying CSV, JSON, and Parquet objects using standard SQL syntax.

## Supported Formats

| Format | Input | Output | Notes |
|---|---|---|---|
| CSV | Supported | Supported | Configurable delimiter, header, comments |
| JSON | Supported | Supported | LINES (JSON-per-line) and DOCUMENT modes |
| Parquet | Supported | CSV, JSON | Column pruning, row group filtering |

## Request Format

```
POST /<bucket>/<key>?select&select-type=2 HTTP/1.1
Host: localhost:9000
Content-Type: application/xml

<SelectObjectContentRequest xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Expression>SELECT * FROM s3object s WHERE s.city = 'Seattle'</Expression>
  <ExpressionType>SQL</ExpressionType>
  <InputSerialization>
    <CSV>
      <FileHeaderInfo>USE</FileHeaderInfo>
      <FieldDelimiter>,</FieldDelimiter>
      <RecordDelimiter>\n</RecordDelimiter>
    </CSV>
  </InputSerialization>
  <OutputSerialization>
    <CSV>
      <FieldDelimiter>,</FieldDelimiter>
      <RecordDelimiter>\n</RecordDelimiter>
    </CSV>
  </OutputSerialization>
</SelectObjectContentRequest>
```

## AWS CLI Examples

### Query CSV Data

```bash
# Sample CSV object: cities.csv
# city,state,population
# Seattle,WA,749256
# Portland,OR,652573
# San Francisco,CA,873965
# Denver,CO,727211

# Select cities with population > 700000
aws --endpoint-url http://localhost:9000 s3api select-object-content \
  --bucket data-bucket \
  --key cities.csv \
  --expression "SELECT city, population FROM s3object WHERE CAST(population AS INT) > 700000" \
  --expression-type SQL \
  --input-serialization '{"CSV": {"FileHeaderInfo": "USE", "FieldDelimiter": ","}}' \
  --output-serialization '{"CSV": {}}' \
  output.csv

cat output.csv
# Seattle,749256
# San Francisco,873965
# Denver,727211
```

### Query JSON Data

```bash
# Sample JSON object: events.jsonl (JSON Lines format)
# {"timestamp":"2026-03-15T10:00:00Z","level":"ERROR","message":"Connection timeout"}
# {"timestamp":"2026-03-15T10:01:00Z","level":"INFO","message":"Request completed"}
# {"timestamp":"2026-03-15T10:02:00Z","level":"ERROR","message":"Disk full"}

# Select only ERROR events
aws --endpoint-url http://localhost:9000 s3api select-object-content \
  --bucket logs-bucket \
  --key events.jsonl \
  --expression "SELECT s.timestamp, s.message FROM s3object s WHERE s.level = 'ERROR'" \
  --expression-type SQL \
  --input-serialization '{"JSON": {"Type": "LINES"}}' \
  --output-serialization '{"JSON": {}}' \
  errors.json
```

### Query Parquet Data

```bash
# Query a Parquet file - only requested columns are read from disk
aws --endpoint-url http://localhost:9000 s3api select-object-content \
  --bucket analytics-bucket \
  --key sales/2026-q1.parquet \
  --expression "SELECT product_id, SUM(CAST(quantity AS INT)) as total FROM s3object GROUP BY product_id" \
  --expression-type SQL \
  --input-serialization '{"Parquet": {}}' \
  --output-serialization '{"CSV": {}}' \
  summary.csv
```

## SQL Syntax

### Supported SQL Features

| Feature | Example |
|---|---|
| Column selection | `SELECT col1, col2 FROM s3object` |
| Wildcard | `SELECT * FROM s3object` |
| WHERE clause | `WHERE col1 = 'value'` |
| Comparison operators | `=`, `!=`, `<`, `>`, `<=`, `>=` |
| Logical operators | `AND`, `OR`, `NOT` |
| LIKE pattern matching | `WHERE name LIKE 'J%'` |
| CAST | `CAST(col AS INT)`, `CAST(col AS FLOAT)` |
| Aggregate functions | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` |
| IS NULL / IS NOT NULL | `WHERE col IS NOT NULL` |
| BETWEEN | `WHERE val BETWEEN 10 AND 20` |
| IN | `WHERE city IN ('Seattle', 'Portland')` |
| LIMIT | `SELECT * FROM s3object LIMIT 100` |

### Table Reference

The table name in S3 Select is always `s3object` (or aliased: `FROM s3object s`).

For CSV with headers, column names match the header row. Without headers, use positional references: `_1`, `_2`, `_3`.

```sql
-- CSV with headers
SELECT city, population FROM s3object WHERE state = 'WA'

-- CSV without headers (positional)
SELECT _1, _3 FROM s3object WHERE _2 = 'WA'

-- JSON
SELECT s.city, s.population FROM s3object s WHERE s.state = 'WA'
```

## Input Serialization Options

### CSV

| Field | Description | Default |
|---|---|---|
| `FileHeaderInfo` | `USE` (use as column names), `IGNORE`, `NONE` | `NONE` |
| `FieldDelimiter` | Column delimiter | `,` |
| `RecordDelimiter` | Row delimiter | `\n` |
| `QuoteCharacter` | Quote character for fields | `"` |
| `QuoteEscapeCharacter` | Escape character inside quotes | `"` |
| `Comments` | Character indicating a comment line | (none) |

### JSON

| Field | Description | Default |
|---|---|---|
| `Type` | `DOCUMENT` (single JSON) or `LINES` (JSON per line) | `DOCUMENT` |

### Parquet

No configuration options needed. Column types and schema are read from the Parquet metadata.

## Output Serialization Options

### CSV Output

| Field | Description | Default |
|---|---|---|
| `FieldDelimiter` | Column delimiter | `,` |
| `RecordDelimiter` | Row delimiter | `\n` |
| `QuoteCharacter` | Quote character | `"` |
| `QuoteFields` | `ALWAYS` or `ASNEEDED` | `ASNEEDED` |

### JSON Output

| Field | Description | Default |
|---|---|---|
| `RecordDelimiter` | Delimiter between records | `\n` |

## Response Format

S3 Select returns results as a stream of events:

- **Records** - the actual query results
- **Stats** - bytes scanned and bytes returned
- **End** - marks the end of the response

## Performance Considerations

- **Parquet** is the most efficient format for S3 Select because column pruning and row group statistics enable skipping irrelevant data on disk
- **CSV/JSON** require scanning the entire object, but only matching rows are transmitted over the network
- For repeated queries on the same data, consider using Neolith's [ETL transforms](./batch-operations.md) to preprocess data into Parquet format

## Edition Availability

| Edition | S3 Select |
|---|---|
| OSS | Not available |
| Enterprise | Full support |
| AI | Full support |

To upgrade to Neolith Enterprise, visit the [upgrade page](https://neolith.dev/enterprise) or contact sales.
