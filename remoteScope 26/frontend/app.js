// ============================================================
// RemoteScope app.js
// Ping-pong TX / prebuffered RX (Binary Packets + Tape Recorder + WebRTC)
// ============================================================

// -----------------------------
// DOM
// -----------------------------
const DOM = {
  roomInput: document.getElementById('roomInput'),
  joinBtn: document.getElementById('joinBtn'),
  connectSerialBtn: document.getElementById('connectSerialBtn'),
  transmitDataBtn: document.getElementById('transmitDataBtn'),
  receiveDataBtn: document.getElementById('receiveDataBtn'),
  statusDot: document.getElementById('serialStatusDot'),
  statusText: document.getElementById('serialStatusText'),
  statsMode: document.getElementById('statsMode'),
  statsVal: document.getElementById('statsVal'),
  statsFreq: document.getElementById('statsFreq'),
  recordBtn: document.getElementById('recordBtn'),
  sendRecordBtn: document.getElementById('sendRecordBtn'),
  playRecordBtn: document.getElementById('playRecordBtn'),
  recordStatus: document.getElementById('recordStatus'),
  localVideo: document.getElementById('localVideo'),
  remoteVideo: document.getElementById('remoteVideo'),
  cameraBtn: document.getElementById('cameraBtn'),
  tabOscBtn: document.getElementById('tabOscBtn'),
  tabFftBtn: document.getElementById('tabFftBtn'),
  oscContainer: document.getElementById('oscContainer'),
  fftContainer: document.getElementById('fftContainer'),
  pipelineDiagram: document.getElementById('pipelineDiagram'),
  pipelineHint: document.getElementById('pipelineHint'),
  moveLeftBtn: document.getElementById('moveLeftBtn'),
  moveRightBtn: document.getElementById('moveRightBtn'),
  publishChainBtn: document.getElementById('publishChainBtn'),
  videoGrid: document.getElementById('videoGrid'),
};

// -----------------------------
// State
// -----------------------------
const State = {
  ws: null,
  room: null,
  isTransmitting: false,
  isReceiving: false,
  serialPort: null,
  serialReader: null,
  serialWriter: null,
  serialWriteChain: Promise.resolve(),
  peerConnections: {},   // { peerId: RTCPeerConnection }
  remoteStreams: {},      // optional
  localStream: null,

  // DYNAMIC FREQUENCY COUNTERS
  actualSampleRate: 2500,
  localSampleAccumulator: 0,
  remoteSampleAccumulator: 0,

  // RECORDING STATE
  isRecording: false,
  recordedData: [],
  receivedRecording: [],
  isPlayingRecording: false,
  playbackInterval: null,

  // WEBRTC SIGNALING
  pendingCandidates: [],
  selfId: null,
  peers: [],
  chain: [],
  draftChain: []
};

function shortId(id) {
  if (!id) return 'Unknown';
  return id.slice(-6);
}

function getMyDraftIndex() {
  return State.draftChain.indexOf(State.selfId);
}

function renderPipeline() {
  if (!DOM.pipelineDiagram) return;

  DOM.pipelineDiagram.innerHTML = '';

  const chainToRender = State.draftChain.length ? State.draftChain : State.chain;
  const hasRoom = !!State.room;
  const myIdx = getMyDraftIndex();

  DOM.moveLeftBtn.disabled = !hasRoom || myIdx <= 0;
  DOM.moveRightBtn.disabled = !hasRoom || myIdx < 0 || myIdx >= chainToRender.length - 1;
  DOM.publishChainBtn.disabled = !hasRoom || chainToRender.length === 0;

  if (!hasRoom || chainToRender.length === 0) {
    DOM.pipelineHint.innerText = 'Join a room to build a signal chain.';
    return;
  }

  DOM.pipelineHint.innerText =
    'Signal flows left → right. Move yourself, then publish the new chain.';

  chainToRender.forEach((peerId, index) => {
    const node = document.createElement('div');
    node.className = 'pipeline-node' + (peerId === State.selfId ? ' self' : '');

    const isFirst = index === 0;
    const isLast = index === chainToRender.length - 1;
    const role = isFirst ? 'Source' : isLast ? 'Sink' : 'Processing Node';

    node.innerHTML = `
      <div class="node-title">${peerId === State.selfId ? 'You' : 'Peer'} ${shortId(peerId)}</div>
      <div class="node-subtitle">${role}</div>
    `;

    DOM.pipelineDiagram.appendChild(node);

    if (index < chainToRender.length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'pipeline-arrow';
      arrow.textContent = '→';
      DOM.pipelineDiagram.appendChild(arrow);
    }
  });
}

function publishChain() {
  if (!State.ws || State.ws.readyState !== WebSocket.OPEN) return;
  if (!State.draftChain.length) return;

  State.ws.send(JSON.stringify({
    type: 'set_chain',
    order: State.draftChain
  }));
}

function moveSelf(delta) {
  if (!State.selfId) return;

  const arr = [...(State.draftChain.length ? State.draftChain : State.chain)];
  const idx = arr.indexOf(State.selfId);
  if (idx < 0) return;

  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= arr.length) return;

  [arr[idx], arr[nextIdx]] = [arr[nextIdx], arr[idx]];
  State.draftChain = arr;
  renderPipeline();
}

function syncDraftChainFromServer(order) {
  State.chain = Array.isArray(order) ? [...order] : [];
  State.draftChain = [...State.chain];
  renderPipeline();
}


// Autonomously track the TRUE hardware bandwidth once per second to fix Arduino C++ Loop overhead skew
setInterval(() => {
  if (State.isReceiving) {
    State.actualSampleRate = State.remoteSampleAccumulator;
  } else {
    State.actualSampleRate = State.localSampleAccumulator;
  }

  // Safety clamp 
  if (State.actualSampleRate < 100) State.actualSampleRate = 2500;

  State.localSampleAccumulator = 0;
  State.remoteSampleAccumulator = 0;
}, 1000);

// -----------------------------
// Signal / chart constants
// -----------------------------
const SAMPLE_RATE_HZ = 2500;
const BLOCK_SIZE = 256;

let maxDataPoints = 1000;
let chartData = Array(maxDataPoints).fill(null);
let chartDataRemote = Array(maxDataPoints).fill(null);
let chartLabels = Array.from({ length: maxDataPoints }, (_, i) => i);
let localCursor = 0;
let remoteCursor = 0;

// -----------------------------
// Chart.js
// -----------------------------
const ctx = document.getElementById('signalChart').getContext('2d');

const gradientCyan = ctx.createLinearGradient(0, 0, 0, 400);
gradientCyan.addColorStop(0, 'rgba(59, 130, 246, 0.4)');
gradientCyan.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

const gradientPurple = ctx.createLinearGradient(0, 0, 0, 400);
gradientPurple.addColorStop(0, 'rgba(139, 92, 246, 0.4)');
gradientPurple.addColorStop(1, 'rgba(139, 92, 246, 0.0)');

const signalChart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: chartLabels,
    datasets: [
      {
        label: 'Local Signal',
        data: chartData,
        borderColor: '#3b82f6',
        backgroundColor: gradientCyan,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
        fill: true
      },
      {
        label: 'Remote Signal',
        data: chartDataRemote,
        borderColor: '#8b5cf6',
        backgroundColor: gradientPurple,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
        fill: true
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: {
        min: 0,
        max: 1023,
        grid: { color: 'rgba(255, 255, 255, 0.1)' },
        ticks: { color: '#8b949e' }
      },
      x: {
        grid: { display: false },
        ticks: { display: false }
      }
    },
    plugins: {
      legend: { display: false }
    }
  }
});

// -----------------------------
// FFT Chart.js
// -----------------------------
const fftCtx = document.getElementById('fftChart').getContext('2d');

let fftLabels = Array.from({ length: 512 }, (_, i) => Math.round(i * (SAMPLE_RATE_HZ / 1024)));
let fftDataLocal = Array(512).fill(0);
let fftDataRemote = Array(512).fill(0);

const fftChart = new Chart(fftCtx, {
  type: 'line',
  data: {
    labels: fftLabels,
    datasets: [
      {
        label: 'Local Spectrum',
        data: fftDataLocal,
        borderColor: '#3b82f6',
        backgroundColor: gradientCyan,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        fill: true
      },
      {
        label: 'Remote Spectrum',
        data: fftDataRemote,
        borderColor: '#8b5cf6',
        backgroundColor: gradientPurple,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        fill: true
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: {
        min: 0,
        grid: { color: 'rgba(255, 255, 255, 0.1)' },
        ticks: { color: '#8b949e' }
      },
      x: {
        grid: { display: false },
        ticks: { color: '#8b949e', maxTicksLimit: 10 }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: { mode: 'index', intersect: false }
    }
  }
});

// ============================================================
// Binary packet format
// ============================================================
const PKT_SYNC1 = 0xA5;
const PKT_SYNC2 = 0x5A;
const PKT_TYPE_SAMPLES = 0x01;
const PKT_TYPE_CONTROL = 0x02;

const CTRL_TX_DISABLE = 0x00;
const CTRL_TX_ENABLE = 0x01;
const CTRL_RX_CLEAR = 0x02;

const HEADER_SIZE = 8;
const CHECKSUM_SIZE = 2;
const MAX_PACKET_SIZE = HEADER_SIZE + BLOCK_SIZE * 2 + CHECKSUM_SIZE;

let browserSeq = 0;

// -----------------------------
// Serial receive parser
// -----------------------------
const SerialRx = {
  parseState: 'WAIT_SYNC1',
  packetBuffer: new Uint8Array(MAX_PACKET_SIZE),
  packetIndex: 0,
  packetExpected: 0
};

// ============================================================
// Helpers
// ============================================================

function checksum16Bytes(bytes, len = bytes.length) {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum = (sum + bytes[i]) & 0xFFFF;
  }
  return sum;
}

function drawChunk(targetArray, cursorRefName, samples) {
  let cursor = cursorRefName === 'local' ? localCursor : remoteCursor;

  for (let i = 0; i < samples.length; i++) {
    targetArray[cursor] = samples[i];
    cursor = (cursor + 1) % maxDataPoints;
  }

  for (let i = 0; i < 20; i++) {
    targetArray[(cursor + i) % maxDataPoints] = null;
  }

  if (cursorRefName === 'local') {
    localCursor = cursor;
  } else {
    remoteCursor = cursor;
  }

  DOM.statsVal.innerText = samples[samples.length - 1] ?? 0;
  requestAnimationFrame(() => signalChart.update());
}

function buildSamplePacket(samples) {
  const count = samples.length;
  const packetLen = HEADER_SIZE + count * 2 + CHECKSUM_SIZE;
  const out = new Uint8Array(packetLen);

  out[0] = PKT_SYNC1;
  out[1] = PKT_SYNC2;
  out[2] = PKT_TYPE_SAMPLES;
  out[3] = browserSeq & 0xFF;
  out[4] = (browserSeq >> 8) & 0xFF;
  out[5] = count & 0xFF;
  out[6] = (count >> 8) & 0xFF;
  out[7] = 0x00;

  let idx = HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    let s = samples[i] | 0;
    if (s < 0) s = 0;
    if (s > 1023) s = 1023;
    out[idx++] = s & 0xFF;
    out[idx++] = (s >> 8) & 0xFF;
  }

  const cksum = checksum16Bytes(out, idx);
  out[idx++] = cksum & 0xFF;
  out[idx++] = (cksum >> 8) & 0xFF;

  browserSeq = (browserSeq + 1) & 0xFFFF;
  return out;
}

function buildControlPacket(cmdByte) {
  const out = new Uint8Array(HEADER_SIZE + 1 + CHECKSUM_SIZE);

  out[0] = PKT_SYNC1;
  out[1] = PKT_SYNC2;
  out[2] = PKT_TYPE_CONTROL;
  out[3] = browserSeq & 0xFF;
  out[4] = (browserSeq >> 8) & 0xFF;
  out[5] = 1;
  out[6] = 0;
  out[7] = 0x00;
  out[8] = cmdByte;

  const cksum = checksum16Bytes(out, 9);
  out[9] = cksum & 0xFF;
  out[10] = (cksum >> 8) & 0xFF;

  browserSeq = (browserSeq + 1) & 0xFFFF;
  return out;
}

async function writePacket(uint8Packet) {
  if (!State.serialWriter) return;
  await State.serialWriter.write(uint8Packet);
}

function queueSerialWriteSamples(samples) {
  if (!samples || samples.length === 0) return;

  State.serialWriteChain = State.serialWriteChain
    .then(async () => {
      for (let i = 0; i < samples.length; i += BLOCK_SIZE) {
        const slice = samples.slice(i, i + BLOCK_SIZE);
        if (slice.length > 0) {
          await writePacket(buildSamplePacket(slice));
        }
      }
    })
    .catch((err) => {
      console.error('Serial write chain failed:', err);
    });
}

async function sendControl(cmdByte) {
  if (!State.serialWriter) return;
  await writePacket(buildControlPacket(cmdByte));
}

// ============================================================
// Serial RX parser
// ============================================================

function handleParsedPacket(packet) {
  const type = packet[2];

  if (type === PKT_TYPE_SAMPLES) {
    const count = packet[5] | (packet[6] << 8);
    const expectedLen = HEADER_SIZE + count * 2 + CHECKSUM_SIZE;
    if (packet.length !== expectedLen) return;

    const rxChecksum = packet[expectedLen - 2] | (packet[expectedLen - 1] << 8);
    const calcChecksum = checksum16Bytes(packet, expectedLen - 2);
    if (rxChecksum !== calcChecksum) {
      console.warn('Sample packet checksum mismatch');
      return;
    }

    const samples = new Array(count);
    let idx = HEADER_SIZE;
    for (let i = 0; i < count; i++) {
      samples[i] = packet[idx] | (packet[idx + 1] << 8);
      idx += 2;
    }

    State.localSampleAccumulator += count;
    drawChunk(chartData, 'local', samples);

    // TAPE RECORDING INJECTION
    if (State.isRecording) {
      State.recordedData.push(...samples);
      DOM.recordStatus.innerText = `Tape: ${State.recordedData.length} spls`;
    }

    if (State.isTransmitting && State.ws && State.ws.readyState === WebSocket.OPEN) {
      State.ws.send(JSON.stringify({
        type: 'signal_chunk',
        values: samples
      }));
    }
  }
}

function parseIncomingSerialByte(byteVal) {
  switch (SerialRx.parseState) {
    case 'WAIT_SYNC1':
      if (byteVal === PKT_SYNC1) {
        SerialRx.packetBuffer[0] = byteVal;
        SerialRx.packetIndex = 1;
        SerialRx.packetExpected = 0;
        SerialRx.parseState = 'WAIT_SYNC2';
      }
      break;

    case 'WAIT_SYNC2':
      if (byteVal === PKT_SYNC2) {
        SerialRx.packetBuffer[1] = byteVal;
        SerialRx.packetIndex = 2;
        SerialRx.packetExpected = 0;
        SerialRx.parseState = 'READING';
      } else if (byteVal === PKT_SYNC1) {
        SerialRx.packetBuffer[0] = byteVal;
        SerialRx.packetIndex = 1;
      } else {
        SerialRx.packetIndex = 0;
        SerialRx.packetExpected = 0;
        SerialRx.parseState = 'WAIT_SYNC1';
      }
      break;

    case 'READING':
      if (SerialRx.packetIndex >= MAX_PACKET_SIZE) {
        SerialRx.packetIndex = 0;
        SerialRx.packetExpected = 0;
        SerialRx.parseState = 'WAIT_SYNC1';
        return;
      }

      SerialRx.packetBuffer[SerialRx.packetIndex++] = byteVal;

      if (SerialRx.packetIndex === HEADER_SIZE) {
        const type = SerialRx.packetBuffer[2];
        const count = SerialRx.packetBuffer[5] | (SerialRx.packetBuffer[6] << 8);

        if (type === PKT_TYPE_SAMPLES) {
          if (count <= 0 || count > BLOCK_SIZE) {
            SerialRx.packetIndex = 0;
            SerialRx.packetExpected = 0;
            SerialRx.parseState = 'WAIT_SYNC1';
            return;
          }
          SerialRx.packetExpected = HEADER_SIZE + count * 2 + CHECKSUM_SIZE;
        } else if (type === PKT_TYPE_CONTROL) {
          if (count <= 0 || count > 16) {
            SerialRx.packetIndex = 0;
            SerialRx.packetExpected = 0;
            SerialRx.parseState = 'WAIT_SYNC1';
            return;
          }
          SerialRx.packetExpected = HEADER_SIZE + count + CHECKSUM_SIZE;
        } else {
          SerialRx.packetIndex = 0;
          SerialRx.packetExpected = 0;
          SerialRx.parseState = 'WAIT_SYNC1';
          return;
        }
      }

      if (SerialRx.packetExpected > 0 && SerialRx.packetIndex === SerialRx.packetExpected) {
        const packet = SerialRx.packetBuffer.slice(0, SerialRx.packetExpected);
        handleParsedPacket(packet);

        SerialRx.packetIndex = 0;
        SerialRx.packetExpected = 0;
        SerialRx.parseState = 'WAIT_SYNC1';
      }
      break;
  }
}

// ============================================================
// Serial connect / read loop
// ============================================================

async function connectSerial() {
  try {
    State.serialPort = await navigator.serial.requestPort();
    await State.serialPort.open({ baudRate: 1000000 });

    State.serialReader = State.serialPort.readable.getReader();
    State.serialWriter = State.serialPort.writable.getWriter();

    DOM.statusDot.classList.replace('disconnected', 'connected');
    DOM.statusText.innerText = 'Arduino Connected';
    DOM.transmitDataBtn.disabled = false;
    DOM.receiveDataBtn.disabled = false;
    DOM.recordBtn.disabled = false;

    // Enable transmitting out of the gate for local scope plotting
    await sendControl(CTRL_TX_ENABLE);

    readLoop();
  } catch (err) {
    console.error('Serial connection failed:', err);
  }
}

async function readLoop() {
  try {
    while (true) {
      const { value, done } = await State.serialReader.read();
      if (done) break;
      if (!value) continue;

      for (let i = 0; i < value.length; i++) {
        parseIncomingSerialByte(value[i]);
      }
    }
  } catch (err) {
    console.error('Serial read error:', err);
  }
}

// ============================================================
// WebSocket relay
// ============================================================

const wsUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === ''
  ? 'ws://174.138.117.37:8081'
  : 'ws://174.138.117.37:8081';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function createPeerConnectionFor(peerId) {
  if (State.peerConnections[peerId]) return;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  State.peerConnections[peerId] = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate && State.ws) {
      State.ws.send(JSON.stringify({
        type: 'candidate',
        to: peerId,
        candidate: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    attachRemoteVideo(peerId, event.streams[0]);
  };

  if (State.localStream) {
    State.localStream.getTracks().forEach(track => {
      pc.addTrack(track, State.localStream);
    });
  }
}

function attachRemoteVideo(peerId, stream) {
  let el = document.getElementById('video_' + peerId);

  if (!el) {
    el = document.createElement('video');
    el.id = 'video_' + peerId;
    el.autoplay = true;
    el.playsInline = true;
    el.style.width = '100%';

    DOM.videoGrid.appendChild(el);
  }

  el.srcObject = stream;
}

function initWebSocket(roomName) {
  State.ws = new WebSocket(wsUrl);

  State.ws.onopen = () => {
    State.room = roomName;
    State.ws.send(JSON.stringify({ type: 'join', room: roomName }));
    DOM.joinBtn.innerText = 'Connected';
    DOM.roomInput.disabled = true;
  };

  State.ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'joined':
        State.selfId = data.selfId;
        State.peers = Array.isArray(data.peers) ? data.peers : [];
        syncDraftChainFromServer(data.order || []);

        // Build peer connections for anyone already there
        State.peers.forEach(peerId => {
          if (peerId !== State.selfId) {
            createPeerConnectionFor(peerId);
          }
        });

        // If camera is already active, offer to everyone
        if (State.localStream) {
          for (const peerId of State.peers) {
            if (peerId !== State.selfId) {
              await createOfferFor(peerId);
            }
          }
        }
        break;

      case 'room_state':
        State.peers = Array.isArray(data.peers) ? data.peers : [];
        syncDraftChainFromServer(data.order || []);

        State.peers.forEach(peerId => {
          if (peerId !== State.selfId) {
            createPeerConnectionFor(peerId);
          }
        });
        break;

      case 'user_joined': {
        const peerId = data.userId;
        if (peerId !== State.selfId) {
          State.peers = [...new Set([...State.peers, peerId])];
          createPeerConnectionFor(peerId);

          // Existing users offer to the new peer if camera is on
          if (State.localStream) {
            await createOfferFor(peerId);
          }
        }
        break;
      }

      case 'user_left': {
        const peerId = data.userId;
        console.log('User left:', peerId);
        State.peers = State.peers.filter(id => id !== peerId);
        closePeerConnection(peerId);
        break;
      }

      case 'offer':
        if (data.from && data.from !== State.selfId) {
          await handleOffer(data.from, data.offer);
        }
        break;

      case 'answer':
        if (data.from && data.from !== State.selfId) {
          await handleAnswer(data.from, data.answer);
        }
        break;

      case 'candidate':
        if (data.from && data.from !== State.selfId) {
          await handleCandidate(data.from, data.candidate);
        }
        break;
    }
  };
}

// ============================================================
// WEBRTC
// ============================================================

// ============================================================
// WEBRTC (multi-peer mesh)
// Everyone in the room can see everyone
// ============================================================

function getPeer(peerId) {
  return State.peerConnections[peerId] || null;
}

function removeRemoteVideo(peerId) {
  const card = document.getElementById(`video_card_${peerId}`);
  if (card) card.remove();
  delete State.remoteStreams[peerId];
}

function attachRemoteVideo(peerId, stream) {
  let card = document.getElementById(`video_card_${peerId}`);
  let video = document.getElementById(`video_${peerId}`);

  if (!card) {
    card = document.createElement('div');
    card.className = 'video-container remote-feed';
    card.id = `video_card_${peerId}`;

    video = document.createElement('video');
    video.id = `video_${peerId}`;
    video.autoplay = true;
    video.playsInline = true;

    const overlay = document.createElement('div');
    overlay.className = 'feed-overlay';

    const label = document.createElement('div');
    label.className = 'feed-label';
    label.textContent = `Peer ${shortId(peerId)}`;

    overlay.appendChild(label);
    card.appendChild(video);
    card.appendChild(overlay);

    DOM.videoGrid.appendChild(card);
  }

  video.srcObject = stream;
  State.remoteStreams[peerId] = stream;
}

function closePeerConnection(peerId) {
  const pc = getPeer(peerId);
  if (pc) {
    try { pc.onicecandidate = null; } catch { }
    try { pc.ontrack = null; } catch { }
    try { pc.onconnectionstatechange = null; } catch { }
    try { pc.oniceconnectionstatechange = null; } catch { }
    try { pc.close(); } catch { }
  }
  delete State.peerConnections[peerId];
  removeRemoteVideo(peerId);
}

function createPeerConnectionFor(peerId) {
  if (!peerId || peerId === State.selfId) return null;
  if (State.peerConnections[peerId]) return State.peerConnections[peerId];

  const pc = new RTCPeerConnection(ICE_SERVERS);
  State.peerConnections[peerId] = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate && State.ws && State.ws.readyState === WebSocket.OPEN) {
      State.ws.send(JSON.stringify({
        type: 'candidate',
        to: peerId,
        candidate: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    console.log('Remote track received from', peerId);
    attachRemoteVideo(peerId, event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    console.log(`pc(${shortId(peerId)}) connectionState:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      // keep UI tidy on hard failure
      // do not auto-close immediately on transient disconnected if you don't want that
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`pc(${shortId(peerId)}) iceConnectionState:`, pc.iceConnectionState);
  };

  if (State.localStream) {
    State.localStream.getTracks().forEach(track => {
      const already = pc.getSenders().some(sender => sender.track === track);
      if (!already) {
        pc.addTrack(track, State.localStream);
      }
    });
  }

  return pc;
}

async function createOfferFor(peerId) {
  const pc = createPeerConnectionFor(peerId);
  if (!pc) return;
  if (pc.signalingState !== 'stable') return;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (State.ws && State.ws.readyState === WebSocket.OPEN) {
      State.ws.send(JSON.stringify({
        type: 'offer',
        to: peerId,
        offer
      }));
    }
  } catch (err) {
    console.error(`Error creating offer for ${peerId}`, err);
  }
}

async function handleOffer(fromPeerId, offer) {
  const pc = createPeerConnectionFor(fromPeerId);
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const pending = State.pendingCandidates
      .filter(item => item.from === fromPeerId);

    State.pendingCandidates = State.pendingCandidates
      .filter(item => item.from !== fromPeerId);

    for (const item of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(item.candidate));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (State.ws && State.ws.readyState === WebSocket.OPEN) {
      State.ws.send(JSON.stringify({
        type: 'answer',
        to: fromPeerId,
        answer
      }));
    }
  } catch (err) {
    console.error(`handleOffer error from ${fromPeerId}`, err);
  }
}

async function handleAnswer(fromPeerId, answer) {
  const pc = getPeer(fromPeerId);
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));

    const pending = State.pendingCandidates
      .filter(item => item.from === fromPeerId);

    State.pendingCandidates = State.pendingCandidates
      .filter(item => item.from !== fromPeerId);

    for (const item of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(item.candidate));
    }
  } catch (err) {
    console.error(`handleAnswer error from ${fromPeerId}`, err);
  }
}

async function handleCandidate(fromPeerId, candidate) {
  const pc = getPeer(fromPeerId);
  if (!pc) {
    State.pendingCandidates.push({ from: fromPeerId, candidate });
    return;
  }

  try {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      State.pendingCandidates.push({ from: fromPeerId, candidate });
    }
  } catch (err) {
    console.error(`handleCandidate error from ${fromPeerId}`, err);
  }
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Camera access requires localhost/https.');
      return;
    }

    if (!State.localStream) {
      State.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });

      DOM.localVideo.srcObject = State.localStream;
      DOM.cameraBtn.innerText = 'Camera Active';
      DOM.cameraBtn.classList.replace('secondary-btn', 'success-btn');
    }

    // Add tracks to all existing peer connections
    for (const peerId of State.peers) {
      if (peerId === State.selfId) continue;
      const pc = createPeerConnectionFor(peerId);
      State.localStream.getTracks().forEach(track => {
        const already = pc.getSenders().some(sender => sender.track === track);
        if (!already) {
          pc.addTrack(track, State.localStream);
        }
      });
    }

    // Create offers to everyone already in the room
    for (const peerId of State.peers) {
      if (peerId === State.selfId) continue;
      await createOfferFor(peerId);
    }
  } catch (err) {
    console.error('Camera error:', err);
    alert(`Camera error: ${err.message}`);
  }
}

// ============================================================
// Event handlers
// ============================================================
DOM.cameraBtn.addEventListener('click', startCamera);
DOM.moveLeftBtn?.addEventListener('click', () => moveSelf(-1));
DOM.moveRightBtn?.addEventListener('click', () => moveSelf(1));
DOM.publishChainBtn?.addEventListener('click', publishChain);
DOM.connectSerialBtn.addEventListener('click', connectSerial);

DOM.joinBtn.addEventListener('click', () => {
  const room = DOM.roomInput.value.trim();
  if (room) initWebSocket(room);
});

DOM.transmitDataBtn.addEventListener('click', async () => {
  State.isTransmitting = !State.isTransmitting;

  if (State.isTransmitting) {
    DOM.transmitDataBtn.innerText = 'Transmitting...';
    DOM.statsMode.innerText = State.isReceiving ? 'TX + RX Mode' : 'TX Mode';
    await sendControl(CTRL_TX_ENABLE);
  } else {
    DOM.transmitDataBtn.innerText = 'Start Tx';
    DOM.statsMode.innerText = State.isReceiving ? 'RX Mode' : 'Idle';
    await sendControl(CTRL_TX_DISABLE);
  }
});

DOM.receiveDataBtn.addEventListener('click', async () => {
  State.isReceiving = !State.isReceiving;

  if (State.isReceiving) {
    DOM.receiveDataBtn.innerText = 'Receiving...';
    DOM.receiveDataBtn.classList.replace('secondary-btn', 'success-btn');
    DOM.statsMode.innerText = State.isTransmitting ? 'TX + RX Mode' : 'RX Mode';

    await sendControl(CTRL_RX_CLEAR);
  } else {
    DOM.receiveDataBtn.innerText = 'Start Rx';
    DOM.receiveDataBtn.classList.replace('success-btn', 'secondary-btn');
    DOM.statsMode.innerText = State.isTransmitting ? 'TX Mode' : 'Idle';

    State.serialWriteChain = Promise.resolve();
  }
});

DOM.recordBtn.addEventListener('click', () => {
  State.isRecording = !State.isRecording;
  if (State.isRecording) {
    State.recordedData = [];
    DOM.recordBtn.innerText = "Stop Rec";
    DOM.recordBtn.style.background = "var(--danger)";
    DOM.recordBtn.style.color = "white";
    DOM.sendRecordBtn.disabled = true;
  } else {
    DOM.recordBtn.innerText = "Record";
    DOM.recordBtn.style.background = "";
    DOM.recordBtn.style.color = "";
    DOM.sendRecordBtn.disabled = State.recordedData.length === 0;
  }
});

DOM.sendRecordBtn.addEventListener('click', () => {
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify({
      type: "recorded_signal",
      values: State.recordedData
    }));
    DOM.recordStatus.innerText = "Tape: Sent!";
  }
});

DOM.playRecordBtn.addEventListener('click', async () => {
  if (State.isPlayingRecording) {
    // Halt Playback
    State.isPlayingRecording = false;
    clearInterval(State.playbackInterval);

    DOM.playRecordBtn.innerText = "Play Rx";
    DOM.playRecordBtn.classList.replace('success-btn', 'secondary-btn');
    DOM.recordStatus.innerText = "Tape: Stopped";
    return;
  }

  if (State.receivedRecording.length > 0) {
    // Toggle OFF Live Receiving Network gently
    if (State.isReceiving) {
      DOM.receiveDataBtn.click();
      await new Promise(r => setTimeout(r, 100)); // allow chain to clear
    }

    await sendControl(CTRL_TX_DISABLE);
    await sendControl(CTRL_RX_CLEAR);

    State.isPlayingRecording = true;
    DOM.playRecordBtn.innerText = "Stop Play";
    DOM.playRecordBtn.classList.replace('secondary-btn', 'success-btn');
    DOM.recordStatus.innerText = `Tape: Playing ${State.receivedRecording.length} spls`;

    // Paced asynchronous playback generator matches C++ buffer (2500Hz drain)
    // Fire 256 samples approx every 102.4ms so we don't overflow the 2048 Ring
    let tapeIndex = 0;

    State.playbackInterval = setInterval(() => {
      if (!State.isPlayingRecording) {
        clearInterval(State.playbackInterval);
        return;
      }
      if (tapeIndex >= State.receivedRecording.length) {
        State.isPlayingRecording = false;
        clearInterval(State.playbackInterval);
        DOM.playRecordBtn.innerText = "Play Rx";
        DOM.playRecordBtn.classList.replace('success-btn', 'secondary-btn');
        DOM.recordStatus.innerText = "Tape: Playback Finished";
        return;
      }

      const slice = State.receivedRecording.slice(tapeIndex, tapeIndex + BLOCK_SIZE);
      drawChunk(chartDataRemote, 'remote', slice);
      queueSerialWriteSamples(slice);
      tapeIndex += BLOCK_SIZE;
    }, 100); // 100ms interval for ~256 samples is extremely stable pacing
  }
});

DOM.cameraBtn.addEventListener('click', startCamera);

DOM.tabOscBtn.addEventListener('click', () => {
  State.isFftActive = false;
  DOM.tabOscBtn.classList.add('active');
  DOM.tabFftBtn.classList.remove('active');
  DOM.oscContainer.style.display = 'block';
  DOM.fftContainer.style.display = 'none';
});

DOM.tabFftBtn.addEventListener('click', () => {
  State.isFftActive = true;
  DOM.tabFftBtn.classList.add('active');
  DOM.tabOscBtn.classList.remove('active');
  DOM.fftContainer.style.display = 'block';
  DOM.oscContainer.style.display = 'none';
  fftChart.resize();
});

// ============================================================
// Cleanup on exit
// ============================================================
window.addEventListener('beforeunload', () => {
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify({ type: 'leave', room: State.room }));
    State.ws.close();
  }
});

// ============================================================
// Optional zoom slider support
// ============================================================

const timeScaleSlider = document.getElementById('timeScaleSlider');
const zoomLabel = document.getElementById('zoomLabel');

if (timeScaleSlider) {
  timeScaleSlider.addEventListener('input', (e) => {
    maxDataPoints = parseInt(e.target.value, 10);

    if (zoomLabel) {
      const msString = ((maxDataPoints / SAMPLE_RATE_HZ) * 1000).toFixed(1);
      zoomLabel.innerText = `${msString} ms`;
    }

    if (chartData.length < maxDataPoints) {
      const diff = maxDataPoints - chartData.length;
      chartData.push(...Array(diff).fill(null));
      chartDataRemote.push(...Array(diff).fill(null));
    } else if (chartData.length > maxDataPoints) {
      chartData.length = maxDataPoints;
      chartDataRemote.length = maxDataPoints;
      localCursor = localCursor % maxDataPoints;
      remoteCursor = remoteCursor % maxDataPoints;
    }

    chartLabels = Array.from({ length: maxDataPoints }, (_, i) => i);
    signalChart.data.labels = chartLabels;
    signalChart.update();
  });
}

// ==========================================
// 8. DYNAMIC FREQUENCY ANALYZER
// ==========================================
function estimateFrequency(dataArray) {
  let sum = 0, count = 0;
  let min = Infinity, max = -Infinity;

  for (let i = 0; i < dataArray.length; i++) {
    if (dataArray[i] !== null) {
      const val = dataArray[i];
      sum += val;
      count++;
      if (val > max) max = val;
      if (val < min) min = val;
    }
  }
  if (count === 0) return 0;

  const mean = sum / count;
  const amplitude = max - min;
  const hysteresis = Math.max(15, amplitude * 0.20);

  let crossings = 0, firstCrossingIndex = -1, lastCrossingIndex = -1;
  let lastSign = null, validSamplesProcessed = 0;

  for (let i = 0; i < dataArray.length; i++) {
    if (dataArray[i] === null) continue;
    validSamplesProcessed++;

    const val = dataArray[i];
    let sign = lastSign;

    if (val > mean + hysteresis) {
      sign = 1;
    } else if (val < mean - hysteresis) {
      sign = -1;
    }

    if (lastSign !== null && lastSign < 0 && sign > 0) {
      if (firstCrossingIndex === -1) firstCrossingIndex = validSamplesProcessed;
      lastCrossingIndex = validSamplesProcessed;
      crossings++;
    }
    lastSign = sign;
  }

  if (crossings > 1) {
    const samplesBetween = lastCrossingIndex - firstCrossingIndex;
    if (samplesBetween > 0) {
      const samplesPerCycle = samplesBetween / (crossings - 1);
      return (State.actualSampleRate / samplesPerCycle);
    }
  }
  return 0;
}

setInterval(() => {
  if (!DOM.statsFreq) return;
  let freq = 0;
  if (State.isReceiving || State.isPlayingRecording) {
    freq = estimateFrequency(chartDataRemote);
  } else {
    freq = estimateFrequency(chartData);
  }

  if (freq > 0) {
    DOM.statsFreq.innerText = freq.toFixed(1) + " Hz";
  } else {
    DOM.statsFreq.innerText = "-- Hz";
  }
}, 500);

// ==========================================
// 9. FFT ALGORITHM & RENDER LOOP
// ==========================================

function computeFFT(real, imag) {
  const n = real.length;
  let i, j, k, n1, n2, a, c, s, t1, t2;

  j = 0;
  for (i = 0; i < n - 1; i++) {
    if (i < j) {
      t1 = real[i]; real[i] = real[j]; real[j] = t1;
      t1 = imag[i]; imag[i] = imag[j]; imag[j] = t1;
    }
    k = n / 2;
    while (k <= j) {
      j -= k;
      k /= 2;
    }
    j += k;
  }

  n1 = 0;
  n2 = 1;
  for (i = 0; i < Math.log2(n); i++) {
    n1 = n2;
    n2 = n2 + n2;
    a = 0;
    for (j = 0; j < n1; j++) {
      c = Math.cos(a);
      s = Math.sin(a);
      a += Math.PI * 2 / n2;
      for (k = j; k < n; k += n2) {
        t1 = c * real[k + n1] - s * imag[k + n1];
        t2 = s * real[k + n1] + c * imag[k + n1];
        real[k + n1] = real[k] - t1;
        imag[k + n1] = imag[k] - t2;
        real[k] = real[k] + t1;
        imag[k] = imag[k] + t2;
      }
    }
  }
}

function updateFFT() {
  if (!State.isFftActive) return;

  const n = 1024;

  const extract = (dataArr, cursor) => {
    const out = new Array(n).fill(0);
    let idx = (cursor - n + maxDataPoints) % maxDataPoints;
    for (let i = 0; i < n; i++) {
      const val = dataArr[(idx + i) % maxDataPoints];
      out[i] = val !== null ? val : 0;
    }
    return out;
  };

  const localSignal = extract(chartData, localCursor);
  const remoteSignal = extract(chartDataRemote, remoteCursor);

  const localImag = new Array(n).fill(0);
  const remoteImag = new Array(n).fill(0);

  const localMean = localSignal.reduce((a, b) => a + b, 0) / n;
  const remoteMean = remoteSignal.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    localSignal[i] -= localMean;
    remoteSignal[i] -= remoteMean;
  }

  for (let i = 0; i < n; i++) {
    const multiplier = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    localSignal[i] *= multiplier;
    remoteSignal[i] *= multiplier;
  }

  computeFFT(localSignal, localImag);
  computeFFT(remoteSignal, remoteImag);

  const halfN = n / 2;
  fftDataLocal.length = halfN;
  fftDataRemote.length = halfN;
  fftLabels.length = halfN;

  const maxFreq = State.actualSampleRate / 2;

  for (let i = 0; i < halfN; i++) {
    fftDataLocal[i] = Math.sqrt(localSignal[i] * localSignal[i] + localImag[i] * localImag[i]) / halfN;
    fftDataRemote[i] = Math.sqrt(remoteSignal[i] * remoteSignal[i] + remoteImag[i] * remoteImag[i]) / halfN;
    fftLabels[i] = Math.round(i * (maxFreq / halfN));
  }

  fftChart.update();
}

setInterval(updateFFT, 66);
