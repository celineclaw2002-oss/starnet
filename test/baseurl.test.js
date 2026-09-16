/* node test/baseurl.test.js — the ONE base-URL law (sidecar/baseurl.js): a provider endpoint or channel service
   URL must be https://, or http:// only to the local machine (127.0.0.1 / localhost / [::1]), and never carry
   user:pass@. Proves (1) the predicate and its messages, (2) every provider adapter refuses a bad endpoint at
   construction (the last line of defense for a value saved before the law), (3) every index.js route that accepts
   an endpoint answers 400 through the shared boundary helper before any provider or channel work. Pure. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const B = require('../sidecar/baseurl.js');

// ---- (1) the predicate: https anywhere, http only to loopback, never userinfo; empty = "no explicit endpoint" ----
{
  for (const ok of ['https://api.example.com/v1', 'HTTPS://api.example.com', 'http://127.0.0.1:11434/v1', 'http://localhost:1234/v1',
    'http://localhost./v1', 'http://[::1]:8080/v1', 'http://127.1/v1', 'http://0x7f000001/', '', '   ', null, undefined]) {
    A.eq(B.baseUrlProblem(ok), '', 'accepts ' + JSON.stringify(ok));
  }
  for (const bad of ['http://api.example.com/v1', 'http://192.168.1.5:8080/v1', 'http://10.0.0.1', 'http://127.0.0.1.evil.com/v1',
    'http://localhost.evil.com/v1', 'http://127.0.0.2/v1', 'https://user:pw@api.example.com/v1', 'https://user@api.example.com',
    'http://u:p@127.0.0.1/v1', 'ftp://api.example.com', 'file:///tmp/x', 'javascript:alert(1)', 'api.example.com/v1', 'not a url',
    '//api.example.com/v1', 'https://', 'http://']) {
    A.ok(B.baseUrlProblem(bad) !== '', 'refuses ' + bad);
  }
  A.ok(/https:\/\//.test(B.baseUrlProblem('http://api.example.com')) && /127\.0\.0\.1/.test(B.baseUrlProblem('http://api.example.com')), 'the cleartext message says https and names the loopback exception');
  A.ok(/credentials/.test(B.baseUrlProblem('https://u:p@x.example')), 'the userinfo message names embedded credentials');
  A.eq(B.baseUrlProblem('http://api.example.com', 'homeserver URL').indexOf('homeserver URL'), 0, 'a label leads the message');
  A.throws(() => B.assertBaseUrl('http://api.example.com'), 'assertBaseUrl throws on a bad value');
  try { B.assertBaseUrl('http://api.example.com'); A.ok(false, 'unreachable'); }
  catch (e) { A.eq(e.status, 400, 'the thrown error carries status 400'); A.eq(e.code, 'bad_base_url', 'and a stable code'); }
  A.eq(B.assertBaseUrl(' https://api.example.com/v1 '), 'https://api.example.com/v1', 'assertBaseUrl returns the trimmed value');
  A.eq(B.cleanBaseUrl('https://api.example.com/v1///', ''), 'https://api.example.com/v1', 'cleanBaseUrl drops trailing slashes');
  A.eq(B.cleanBaseUrl('', 'https://d.example/v1'), 'https://d.example/v1', 'cleanBaseUrl falls back to the adapter default');
  A.eq(B.cleanBaseUrl('', ''), '', 'cleanBaseUrl keeps an endpointless adapter endpointless (it must refuse loudly later, never reroute)');
  A.throws(() => B.cleanBaseUrl('http://api.example.com/v1', ''), 'cleanBaseUrl refuses a cleartext non-loopback endpoint');
  A.ok(B.isLoopbackHost('[::1]') && B.isLoopbackHost('LOCALHOST') && !B.isLoopbackHost('') && !B.isLoopbackHost('localhost.evil'), 'isLoopbackHost');
}

// ---- (2) every adapter applies the law when constructed ----
{
  const noFetch = async () => { throw new Error('fetch must not be reached'); };
  const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
  const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
  const { makeGeminiProvider } = require('../sidecar/providers/gemini.js');
  A.throws(() => makeOpenAICompatibleProvider({ fetch: noFetch, baseUrl: 'http://api.example.com/v1' }), 'openai-compatible refuses a cleartext non-loopback endpoint');
  A.throws(() => makeOpenAICompatibleProvider({ fetch: noFetch, baseUrl: 'https://u:p@api.example.com/v1' }), 'openai-compatible refuses embedded credentials');
  A.notThrows(() => makeOpenAICompatibleProvider({ fetch: noFetch, baseUrl: 'http://localhost:11434/v1' }), 'openai-compatible keeps local Ollama / vLLM / LM Studio over http');
  A.notThrows(() => makeOpenAICompatibleProvider({ fetch: noFetch, baseUrl: 'http://[::1]:8000/v1' }), 'openai-compatible keeps [::1] over http');
  A.throws(() => makeAnthropicProvider({ fetch: noFetch, key: 'k', baseUrl: 'http://proxy.example/v1' }), 'anthropic refuses a cleartext non-loopback endpoint');
  A.notThrows(() => makeAnthropicProvider({ fetch: noFetch, key: 'k' }), 'anthropic keeps its https default');
  A.throws(() => makeGeminiProvider({ fetch: noFetch, key: 'k', baseUrl: 'http://proxy.example/v1beta' }), 'gemini refuses a cleartext non-loopback endpoint');
  A.notThrows(() => makeGeminiProvider({ fetch: noFetch, key: 'k' }), 'gemini keeps its https default');
}

// ---- (3) every index.js boundary that accepts an endpoint refuses through the shared helper ----
{
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const helper = A.fnBody(indexSrc, 'function refuseBadBaseUrl(');
  A.ok(/writeHead\(400/.test(helper) && /baseUrlProblem\(/.test(helper), 'the boundary helper answers 400 with the shared message');
  for (const h of ['async function handleRun(', 'async function handleSetKey(', 'async function handleChannelConnect(',
    'async function handleTelegramBotAdd(', 'async function handleDiscordConnect(', 'async function handleGenericChannelConnect(',
    'async function handleProviderProbe(', 'async function handleProviderValidate(', 'async function handleProviderModels(']) {
    A.ok(/refuseBadBaseUrl\(res, /.test(A.fnBody(indexSrc, h)), 'route applies the base-URL law before any provider work: ' + h);
  }
  A.ok(/refuseBadBaseUrl\(res, endpoint, 'homeserver URL'\)/.test(A.fnBody(indexSrc, 'async function handleGenericChannelConnect(')), 'the Matrix homeserver URL is held to the same law');
}

A.report('baseurl.test');
