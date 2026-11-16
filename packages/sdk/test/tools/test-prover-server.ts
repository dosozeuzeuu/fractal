// Test-only: native prover over HTTP on localhost, for UI tests where browser proving can't run.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Prover } from '../../src/prover.js';
const circuit = JSON.parse(readFileSync(new URL('../../circuit/transact.json', import.meta.url), 'utf8'));
const prover = new Prover(circuit, { crsPath: process.env.CRS_PATH });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'cross-origin-resource-policy': 'cross-origin' };
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  for await (const c of req) body += c;
  try {
    const out = await prover.prove(JSON.parse(body));
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, cors).end(String((e as Error).message));
  }
}).listen(4174, '127.0.0.1', () => console.log('test prover on :4174'));
