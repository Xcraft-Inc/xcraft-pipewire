'use strict';

const {listCaptureNodes} = require('..');

const nodes = listCaptureNodes();

for (const node of nodes) {
  const icon = node.isCapture ? '🎙️' : '🔊';
  const title = node.description || node.name || '(unnamed)';

  console.log(`${icon} ${node.id} ${node.mediaClass} ${title}`);
  console.log(`   node.name: ${node.name || '-'}`);

  if (node.alsaCardName) {
    console.log(`   alsa.card_name: ${node.alsaCardName}`);
  }

  if (node.deviceId) {
    console.log(`   device.id: ${node.deviceId}`);
  }
}
