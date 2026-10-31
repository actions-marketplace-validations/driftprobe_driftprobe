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
    Authorization: Bearer ${DRIFTPROBE_API_TOKEN}
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

A field listed in a contract must carry a value in at least one item, whatever its rules. `min_coverage: 0` makes it optional. An unknown rule is refused, so a typo cannot silently turn a check off.

Nested fields use dots, and arrays use `[]`: `seller.city`, `offers[].price`.

Secrets are read from the environment with `${DRIFTPROBE_NAME}` and never written to a contract. A contract only reads variables that start with `DRIFTPROBE_`, so a contract you did not write cannot reach your other secrets.

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

A contract learned with `--observed` checks the proxy's latest observation and counts the time passed since. After 7 days without one, it reports "could not be checked" instead of staying green: set `source.max_silence` (`30d`) if your agent runs less often.

`check` follows redirects on the same host only: another host would receive your headers, so it fails and asks you to point the contract there directly. Responses above 50 MB are refused.

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
          DRIFTPROBE_API_TOKEN: ${{ secrets.API_TOKEN }}
```

The Action runs the code of its own tag, with the dependencies of its lockfile.

Exit codes: `0` all good, `1` a contract is broken, `2` a source could not be checked. `--github` adds annotations, `--json` prints machine readable results.

## What is stored

Shapes, never values. For each field: how many items carry a value, which types were seen, how many distinct values, and the age of the newest date. Keys that do not read like schema names (emails, identifiers, dotted names, maps with very many keys) are collapsed to `*`, and so are path segments that look like ids or tokens.

Names are kept, because a contract is made of them. A person's name used as a JSON key or as a path word (`/users/jean-dupont`) reads like a schema name and ends up in `observed.jsonl` and in the contract: read a contract before you commit it.

The proxy listens on `127.0.0.1` only, answers local requests only, always forwards to the configured upstream, and does not store query strings, headers or request bodies. It rotates `observed.jsonl` at 50 MB and keeps one previous file. When `learn` finds what looks like a credential in a URL or in tool arguments, the contract gets a `${DRIFTPROBE_VARIABLE}` instead and tells you which one to set.

## Status

Early prototype. Today driftprobe learns from what your agent **receives**, and `--fields` narrows a contract to what it **reads**. Detecting that automatically from the agent's behaviour is the next step.

## License

MIT
