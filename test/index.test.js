'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _createApi, InputStream } = require('..');

test('InputStream.close is idempotent', () => {
  let closeCount = 0;
  const stream = new InputStream({
    close() {
      closeCount++;
    },
  });

  stream.close();
  stream.close();

  assert.equal(closeCount, 1);
  assert.equal(stream.closed, true);
});

test('InputStream Symbol.dispose calls close', () => {
  let closeCount = 0;
  const stream = new InputStream({
    close() {
      closeCount++;
    },
  });

  stream[Symbol.dispose]();
  stream[Symbol.dispose]();

  assert.equal(closeCount, 1);
});

test('openInputStream validates callback', () => {
  const api = _createApi({
    openInputStream() {
      throw new Error('should not be called');
    },
    listCaptureNodes() {
      return [];
    },
  });

  assert.throws(
    () => api.openInputStream('', 1, 'f32', 48000, 1024, null),
    /dataCallback must be a function/
  );
});

test('openInputStream validates sample format', () => {
  const api = _createApi({
    openInputStream() {
      throw new Error('should not be called');
    },
    listCaptureNodes() {
      return [];
    },
  });

  assert.throws(
    () => api.openInputStream('', 1, 'u8', 48000, 1024, () => {}),
    /sampleFormat/
  );
});

test('openInputStream passes normalized values to native addon', () => {
  const calls = [];

  const api = _createApi({
    openInputStream(...args) {
      calls.push(args);
      return { close() {} };
    },
    listCaptureNodes() {
      return [];
    },
  });

  const callback = () => {};
  const stream = api.openInputStream(null, null, null, null, null, callback);

  assert.equal(stream.closed, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['', 1, 'f32', 48000, 1024, callback]);
});

test('list helpers normalize and filter nodes', () => {
  const api = _createApi({
    openInputStream() {
      return { close() {} };
    },
    listCaptureNodes() {
      return [
        {
          id: 12,
          name: 'source.one',
          description: 'Source One',
          mediaClass: 'Audio/Source',
          isAudio: true,
          isCapture: true,
          isSink: false,
        },
        {
          id: 13,
          name: 'sink.one',
          description: 'Sink One',
          mediaClass: 'Audio/Sink',
          isAudio: true,
          isCapture: false,
          isSink: true,
        },
      ];
    },
  });

  assert.equal(api.listCaptureNodes().length, 2);
  assert.deepEqual(api.listInputNodes().map((node) => node.name), ['source.one']);
  assert.deepEqual(api.listSinkNodes().map((node) => node.name), ['sink.one']);
  assert.equal(api.findNodeByName('source.one').description, 'Source One');
  assert.equal(api.findNodeByText('sink').name, 'sink.one');
  assert.equal(api.findNodeByText('missing'), null);
});
