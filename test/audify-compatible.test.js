'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const compat = require('../lib/audify-compatible');
const { _internals } = compat;

test('audify-compatible exposes RtAudio-like sample format names', () => {
  const backend = new compat();

  assert.equal(backend.SampleFormat.SINT16, 's16');
  assert.equal(backend.SampleFormat.FLOAT32, 'f32');
  assert.equal(backend.SampleFormat.SINT8, 's8');
  assert.equal(backend.SampleFormat.SINT24, 's24');
  assert.equal(backend.SampleFormat.SINT32, 's32');
});

test('audify-compatible normalizes supported formats', () => {
  assert.equal(_internals.normalizeFormat('s16'), 's16');
  assert.equal(_internals.normalizeFormat('int16'), 's16');
  assert.equal(_internals.normalizeFormat('f32'), 'f32');
  assert.equal(_internals.normalizeFormat('float32'), 'f32');
});

test('audify-compatible rejects formats not implemented by native addon yet', () => {
  assert.throws(() => _internals.normalizeFormat('s8'), /does not support/);
  assert.throws(() => _internals.normalizeFormat('s24'), /does not support/);
  assert.throws(() => _internals.normalizeFormat('s32'), /does not support/);
});

test('audify-compatible maps PipeWire node to audify-like device', () => {
  const device = _internals.toAudifyDevice({
    id: 42,
    name: 'alsa_input.test.source',
    description: 'Test Source',
    mediaClass: 'Audio/Source',
    isCapture: true,
    isSink: false,
    audioChannels: 1,
    audioRate: 44100,
  });

  assert.equal(device.id, 'alsa_input.test.source');
  assert.equal(device.nativeId, 42);
  assert.equal(device.name, 'Test Source');
  assert.equal(device.inputChannels, 1);
  assert.equal(device.outputChannels, 0);
  assert.equal(device.sampleRate, 44100);
  assert.equal(device.isDefaultInput, false);
  assert.equal(device.isDefaultOutput, false);
});
