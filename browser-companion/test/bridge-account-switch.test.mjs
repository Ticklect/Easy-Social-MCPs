import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { makeServer } from '../server.mjs';

const socketOpen = (socket) => new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

function replyTo(socket, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No response for ${id}`)); }, 1200);
    const onMessage = (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.id !== id) return;
      cleanup();
      resolve(data);
    };
    const onClose = () => { cleanup(); resolve({ error: { message: 'Client disconnected after browser selection changed' } }); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

test('existing CDP page cannot continue commands when a second browser connects', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-bridge-selection-test-'));
  const bridge = makeServer({ port: 0, directory });
  const sockets = [];
  let forwarded = 0;
  let releasePendingReply;
  let announcePendingCommand;
  const pendingCommandObserved = new Promise((resolve) => { announcePendingCommand = resolve; });
  try {
    const port = await bridge.start();
    const key = fs.readFileSync(bridge.keyPath, 'utf8');
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    const connectExtension = async (browserId, serve = false) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?key=${key}&browserId=${browserId}`, { origin });
      sockets.push(ws);
      if (serve) ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (!Number.isSafeInteger(message.id)) return;
        if (message.type === 'list') {
          ws.send(JSON.stringify({ id: message.id, result: [
            { id: 7, type: 'page', url: 'https://www.reddit.com/', title: 'Reddit', active: true },
          ] }));
        } else if (message.type === 'command') {
          forwarded++;
          const sendReceipt = () => ws.send(JSON.stringify({ id: message.id, result: { result: { value: true } } }));
          if (forwarded === 2) {
            releasePendingReply = sendReceipt;
            announcePendingCommand();
          } else sendReceipt();
        }
      });
      await socketOpen(ws);
      return ws;
    };
    await connectExtension('b'.repeat(32), true);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(response.status, 200);
    const pages = await response.json();
    assert.equal(pages.length, 1);
    const page = new WebSocket(pages[0].webSocketDebuggerUrl);
    sockets.push(page);
    await socketOpen(page);
    let receipt = replyTo(page, 1);
    page.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' } }));
    assert.ok((await receipt).result);
    assert.equal(forwarded, 1);

    // A command is already in flight when browser #2 arrives. Do not turn a
    // late response into an unambiguous success receipt.
    receipt = replyTo(page, 2);
    page.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' } }));
    await pendingCommandObserved;
    await connectExtension('c'.repeat(32));
    releasePendingReply();
    const result = await receipt;
    assert.ok(result.error, 'An in-flight command must not report success after browser ambiguity');

    // The old page socket is still connected; subsequent commands must not
    // silently dispatch to the original account either.
    receipt = replyTo(page, 3);
    page.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' } }));
    assert.ok((await receipt).error, 'An ambiguous account must refuse an existing page connection');
    assert.equal(forwarded, 2, 'No new command may reach either account after ambiguity');
  } finally {
    for (const socket of sockets) socket.terminate();
    await bridge.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
