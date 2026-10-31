# driftprobe

**Your API returns 200. Your agent still gets garbage.**

driftprobe tests the data your AI agent really receives from APIs and MCP tools. It catches the source that keeps answering, with the same schema, while the content your agent depends on quietly degrades: prices gone from most results, a feed that stopped updating, a column frozen on one value, an empty list instead of an error.

Uptime checks stay green in those cases. Schema diffing stays green too. The agent carries on and produces a confident, wrong result.

## How it works

1. **Record.** Put a local proxy between your agent and a source. It forwards everything untouched and writes down the shape of each response: never the values.
2. **Learn.** Turn what was observed into a contract, a small YAML file you keep in your repo.
3. **Check.** Run the contract in CI or on a schedule. It fails with a plain sentence that names the field.

```console
$ driftprobe check contracts/*.yaml
GET /products
  x price: only 16% of 50 items carry a value (contract: at least 90%)
  x updated_at: newest value is 289 days old (contract: 3d)

1 contract(s): 0 ok, 1 broken, 0 could not be checked
```

The API behind that output was answering `200 OK` with an unchanged schema. You can reproduce it in a minute, see [Try it](#try-it).

## Try it

Requires Node 22 or later. To use it on your own sources, run `npx driftprobe` or install it with `npm install -g driftprobe`. The demo below runs from a clone.

```bash
git clone https://github.com/driftprobe/driftprobe && cd driftprobe && npm install

# A demo API, and the proxy in front of it
node examples/demo-api.mjs &
node bin/driftprobe.mjs record --upstream http://127.0.0.1:4010 --port 8787 &

# Your agent calls the proxy instead of the API
curl -s http://127.0.0.1:8787/products > /dev/null
curl -s http://127.0.0.1:8787/products > /dev/null

# Learn a contract from those calls, and check it: all good
node bin/driftprobe.mjs learn --observed .driftprobe/observed.jsonl --out-dir contracts
node bin/driftprobe.mjs check contracts/*.yaml

# The source degrades, and still answers 200 OK
curl -s -X POST http://127.0.0.1:4010/__break
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8787/products

# The contract catches it
node bin/driftprobe.mjs check contracts/*.yaml
```

## The contract

```yaml
version: 1
name: product-search
source:
  type: http
  url: https://api.example.com/products?q=shoes
  headers:
    Authorization: Bearer ${API_TOKEN}
items: results
expect:
  min_items: 20
  fields:
    name: { type: string, min_coverage: 0.99 }
    price: { type: number, min_coverage: 0.9, min_distinct: 2 }
    updated_at: { type: date, max_age: 48h }
```

| Rule | Fails when |
|---|---|
| `min_items` | The list is shorter than expected, or missing (default: 1) |
| `min_coverage` | Too few items carry a usable value. `null`, `""`, `[]` and `{}` do not count |
| `type` | Values changed type: `string`, `number`, `boolean`, `date`, `array`, `object` |
| `max_age` | The newest date in the field is too old (`30m`, `48h`, `7d`) |
| `min_distinct` | Every item shares the same value, like a price stuck at 0 |

Nested fields use dots, and arrays use `[]`: `seller.city`, `offers[].price`.

Secrets are read from the environment with `${NAME}` and never written to a contract.

## Sources

```bash
# A live API
driftprobe learn https://api.example.com/products --name products --out contracts/products.yaml

# Only the fields your agent actually reads
driftprobe learn https://api.example.com/products --name products --fields name,price --out contracts/products.yaml

# An MCP tool
driftprobe learn --mcp https://example.com/mcp --tool search --args '{"q":"shoes"}' --name search --out contracts/search.yaml

# Everything the proxy saw: one contract per route or tool
driftprobe learn --observed .driftprobe/observed.jsonl --out-dir contracts
```

The proxy understands MCP over HTTP, including server-sent events, and groups calls by tool name.

## In CI

```yaml
# .github/workflows/data-contracts.yml
on:
  schedule:
    - cron: '0 6 * * *'
jobs:
  contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: driftprobe/driftprobe@v0
        with:
          contracts: contracts/*.yaml
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}
```

Exit codes: `0` all good, `1` a contract is broken, `2` a source could not be checked. `--github` adds annotations, `--json` prints machine readable results.

## What is stored

Shapes, never content. For each field: how many items carry a value, which types were seen, how many distinct values, and the age of the newest date. Keys that do not read like schema names (emails, identifiers, dotted names, maps with very many keys) are collapsed to `*`, and so are path segments that look like ids or tokens.

The proxy listens on `127.0.0.1` only, answers local requests only, always forwards to the configured upstream, and does not store query strings, headers or request bodies. When `learn` finds a credential in a URL, the contract gets a `${VARIABLE}` instead.

## Status

Early prototype. Today driftprobe learns from what your agent **receives**, and `--fields` narrows a contract to what it **reads**. Detecting that automatically from the agent's behaviour is the next step.

## License

MIT
