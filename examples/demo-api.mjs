// A small product API for the demo. POST /__break makes it degrade the way real sources do:
// still 200 OK, same JSON schema, but most prices are gone and the feed stopped updating.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
let broken = false;

function products() {
  const fresh = new Date().toISOString();
  return Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `Product ${i + 1}`,
    price: broken && i >= 8 ? null : 10 + i,
    in_stock: i % 3 !== 0,
    updated_at: broken ? '2026-01-15T08:00:00Z' : fresh,
  }));
}

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__break') {
      broken = true;
      res.end('broken\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: products() }));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`demo API on http://127.0.0.1:${PORT}`));
