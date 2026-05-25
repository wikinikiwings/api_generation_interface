// Wrapper around Next.js standalone server.js that raises Node's HTTP
// keep-alive and headers timeouts above the upstream idle timeout of the
// reverse proxy in front (Caddy uses Go transport defaults — ~120s
// `IdleConnTimeout`).
//
// Without this, Node's default `server.keepAliveTimeout = 5000ms` closes
// idle connections far sooner than Caddy notices, opening a ~115s race
// window where Caddy reuses a stale conn from its pool, kernel returns
// RST on first write, and Caddy responds 502 to the client. Symptoms in
// the Caddy access log look like:
//
//   readfrom tcp ... write tcp ...: use of closed network connection
//   wsasend: An existing connection was forcibly closed by the remote host
//
// This affects POSTs more than GETs because POSTs write the request body
// onto the upstream socket; the stale-conn RST surfaces during that write.
//
// Reference: https://adamcrowder.net/posts/node-express-api-and-aws-alb-502/
// (the AWS ALB write-up is the canonical version of this fix; the same
// mechanism applies to Caddy / nginx / any reverse-proxy with a pool).
//
// Required order: `headersTimeout > keepAliveTimeout`, else Node sometimes
// drops keep-alive earlier than expected because the headers timeout fires
// during an otherwise-idle period.

const http  = require('node:http');
const https = require('node:https');

const KEEP_ALIVE_TIMEOUT_MS = 120_000; // 120s — must exceed Caddy upstream idle (~120s default)
const HEADERS_TIMEOUT_MS    = 125_000; // 125s — must exceed keepAliveTimeout

function patchCreateServer(mod) {
  const orig = mod.createServer.bind(mod);
  mod.createServer = function patchedCreateServer(...args) {
    const server = orig(...args);
    const apply = () => {
      server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
      server.headersTimeout   = HEADERS_TIMEOUT_MS;
    };
    apply();
    // Re-affirm on 'listening' in case Next.js (or any future framework
    // change) writes back the defaults after createServer returns.
    server.once('listening', apply);
    return server;
  };
}

patchCreateServer(http);
patchCreateServer(https);

// Hand off to Next.js's generated standalone entry. From this point the
// patched http/https.createServer is what Next.js calls — confirmed by
// node_modules/next/dist/server/lib/start-server.js line 169 which picks
// http or https based on a selfSignedCertificate flag.
require('./server.js');
