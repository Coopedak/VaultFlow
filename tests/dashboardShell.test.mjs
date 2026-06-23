import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../.claude/helpers/dashboard/server.mjs';

async function boot() {
  const srv = startServer({ port: 0 });
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

test('vendored chart + cytoscape assets are served', async () => {
  const { srv, base } = await boot();
  try {
    for (const f of ['/vendor/chart.umd.min.js', '/vendor/cytoscape.min.js']) {
      const r = await fetch(base + f);
      assert.equal(r.status, 200, `${f} should be 200`);
      const body = await r.text();
      assert.ok(body.length > 1000, `${f} should have real content`);
    }
  } finally { srv.close(); }
});
