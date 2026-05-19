'use strict';

const {openInputStream} = require('..');

let chunks = 0;
let bytes = 0;

const stream = openInputStream('', 1, 'f32', 48000, 1024, (buffer, info) => {
  chunks++;
  bytes += buffer.length;

  if (chunks % 50 === 0) {
    console.log({chunks, bytes, info});
  }
});

process.once('SIGINT', () => {
  stream.close();
  process.exit(0);
});

setTimeout(() => {
  stream.close();
  console.log({chunks, bytes});
}, 5000);
