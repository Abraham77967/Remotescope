// ============================================================
// LabLink Unified Transceiver
// Ping-pong TX capture + buffered RX playback
// Same sketch on both boards
// TX input:  A1
// RX output: A0
// ============================================================

#include <Arduino.h>

const int ANALOG_PIN_IN = A1;
const int DAC_PIN_OUT = A0;

const uint32_t SAMPLE_RATE_HZ = 2500;
const uint32_t INTERVAL_US = 1000000UL / SAMPLE_RATE_HZ;

const uint16_t BLOCK_SIZE = 256;

// -----------------------------
// Binary packet format
// Must match app.js
// -----------------------------
const uint8_t PKT_SYNC1 = 0xA5;
const uint8_t PKT_SYNC2 = 0x5A;
const uint8_t PKT_TYPE_SAMPLES = 0x01;
const uint8_t PKT_TYPE_CONTROL = 0x02;

const uint8_t CTRL_TX_DISABLE = 0x00;
const uint8_t CTRL_TX_ENABLE = 0x01;
const uint8_t CTRL_RX_CLEAR = 0x02;

const uint16_t HEADER_SIZE = 8;
const uint16_t CHECKSUM_SIZE = 2;
const uint16_t MAX_PACKET_SIZE = HEADER_SIZE + BLOCK_SIZE * 2 + CHECKSUM_SIZE;

// -----------------------------
// TX ping-pong buffers
// -----------------------------
uint16_t txBufA[BLOCK_SIZE];
uint16_t txBufB[BLOCK_SIZE];

bool txActive = false;
bool fillA = true;
uint16_t txFillIndex = 0;
bool txReadyA = false;
bool txReadyB = false;
uint16_t txSeq = 0;
uint32_t lastSampleMicros = 0;
uint32_t txOverflowCount = 0;

// -----------------------------
// RX ring buffer
// -----------------------------
const uint16_t RX_RING_SIZE = 2048;
uint16_t rxRing[RX_RING_SIZE];
volatile uint16_t rxHead = 0;
volatile uint16_t rxTail = 0;

bool rxPrebuffering = true;
bool rxPlaying = false;
uint32_t lastPlayMicros = 0;
uint16_t lastDacOut = 0;
uint32_t rxUnderrunCount = 0;
uint32_t rxOverflowCount = 0;

const uint16_t PREBUFFER_SAMPLES = BLOCK_SIZE * 4; // 3 blocks before start

// -----------------------------
// Serial RX parser state
// -----------------------------
enum ParseState {
  WAIT_SYNC1,
  WAIT_SYNC2,
  READING_PACKET
};

ParseState parseState = WAIT_SYNC1;
uint8_t packetBuffer[MAX_PACKET_SIZE];
uint16_t packetIndex = 0;
uint16_t packetExpected = 0;

// ============================================================
// Utility
// ============================================================

uint16_t checksum16Bytes(const uint8_t *bytes, uint16_t len) {
  uint32_t sum = 0;
  for (uint16_t i = 0; i < len; i++) {
    sum += bytes[i];
  }
  return (uint16_t)(sum & 0xFFFF);
}

uint16_t rxCount() {
  return (uint16_t)((rxHead - rxTail + RX_RING_SIZE) % RX_RING_SIZE);
}

uint16_t rxFreeSpace() {
  return (uint16_t)(RX_RING_SIZE - 1 - rxCount());
}

void rxClear() {
  rxHead = 0;
  rxTail = 0;
  rxPrebuffering = true;
  rxPlaying = false;
  analogWrite(DAC_PIN_OUT, 0);
  lastDacOut = 0;
}

bool rxPush(uint16_t sample) {
  uint16_t nextHead = (uint16_t)((rxHead + 1) % RX_RING_SIZE);
  if (nextHead == rxTail) {
    rxOverflowCount++;
    return false;
  }
  rxRing[rxHead] = sample;
  rxHead = nextHead;
  return true;
}

bool rxPop(uint16_t &sample) {
  if (rxHead == rxTail)
    return false;
  sample = rxRing[rxTail];
  rxTail = (uint16_t)((rxTail + 1) % RX_RING_SIZE);
  return true;
}

void sendSamplePacket(const uint16_t *samples, uint16_t count) {
  uint16_t packetLen = HEADER_SIZE + count * 2 + CHECKSUM_SIZE;
  uint8_t out[MAX_PACKET_SIZE];

  out[0] = PKT_SYNC1;
  out[1] = PKT_SYNC2;
  out[2] = PKT_TYPE_SAMPLES;
  out[3] = (uint8_t)(txSeq & 0xFF);
  out[4] = (uint8_t)((txSeq >> 8) & 0xFF);
  out[5] = (uint8_t)(count & 0xFF);
  out[6] = (uint8_t)((count >> 8) & 0xFF);
  out[7] = 0x00;

  uint16_t idx = HEADER_SIZE;
  for (uint16_t i = 0; i < count; i++) {
    uint16_t s = samples[i];
    if (s > 1023)
      s = 1023;
    out[idx++] = (uint8_t)(s & 0xFF);
    out[idx++] = (uint8_t)((s >> 8) & 0xFF);
  }

  uint16_t cksum = checksum16Bytes(out, idx);
  out[idx++] = (uint8_t)(cksum & 0xFF);
  out[idx++] = (uint8_t)((cksum >> 8) & 0xFF);

  Serial.write(out, packetLen);
  txSeq++;
}

void handleControlCommand(uint8_t cmd) {
  if (cmd == CTRL_TX_DISABLE) {
    txActive = false;
    txFillIndex = 0;
    txReadyA = false;
    txReadyB = false;
  } else if (cmd == CTRL_TX_ENABLE) {
    txActive = true;
    fillA = true;
    txFillIndex = 0;
    txReadyA = false;
    txReadyB = false;
    lastSampleMicros = micros();
  } else if (cmd == CTRL_RX_CLEAR) {
    rxClear();
  }
}

void handleParsedPacket(const uint8_t *packet, uint16_t len) {
  uint8_t type = packet[2];
  uint16_t count = (uint16_t)(packet[5] | (packet[6] << 8));

  uint16_t rxChecksum = (uint16_t)(packet[len - 2] | (packet[len - 1] << 8));
  uint16_t calcChecksum = checksum16Bytes(packet, len - 2);
  if (rxChecksum != calcChecksum)
    return;

  if (type == PKT_TYPE_CONTROL) {
    if (count < 1)
      return;
    uint8_t cmd = packet[HEADER_SIZE];
    handleControlCommand(cmd);
    return;
  }

  if (type == PKT_TYPE_SAMPLES) {
    if (count == 0 || count > BLOCK_SIZE)
      return;

    uint16_t needed = count;
    if (rxFreeSpace() < needed) {
      rxOverflowCount++;
      return;
    }

    uint16_t idx = HEADER_SIZE;
    for (uint16_t i = 0; i < count; i++) {
      uint16_t s = (uint16_t)(packet[idx] | (packet[idx + 1] << 8));
      idx += 2;
      if (s > 1023)
        s = 1023;
      rxPush(s);
    }
  }
}

void parseIncomingSerialByte(uint8_t byteVal) {
  switch (parseState) {
  case WAIT_SYNC1:
    if (byteVal == PKT_SYNC1) {
      packetBuffer[0] = byteVal;
      packetIndex = 1;
      packetExpected = 0;
      parseState = WAIT_SYNC2;
    }
    break;

  case WAIT_SYNC2:
    if (byteVal == PKT_SYNC2) {
      packetBuffer[1] = byteVal;
      packetIndex = 2;
      packetExpected = 0;
      parseState = READING_PACKET;
    } else if (byteVal == PKT_SYNC1) {
      packetBuffer[0] = byteVal;
      packetIndex = 1;
    } else {
      packetIndex = 0;
      packetExpected = 0;
      parseState = WAIT_SYNC1;
    }
    break;

  case READING_PACKET:
    if (packetIndex >= MAX_PACKET_SIZE) {
      packetIndex = 0;
      packetExpected = 0;
      parseState = WAIT_SYNC1;
      return;
    }

    packetBuffer[packetIndex++] = byteVal;

    if (packetIndex == HEADER_SIZE) {
      uint8_t type = packetBuffer[2];
      uint16_t count = (uint16_t)(packetBuffer[5] | (packetBuffer[6] << 8));

      if (type == PKT_TYPE_SAMPLES) {
        if (count == 0 || count > BLOCK_SIZE) {
          packetIndex = 0;
          packetExpected = 0;
          parseState = WAIT_SYNC1;
          return;
        }
        packetExpected = HEADER_SIZE + count * 2 + CHECKSUM_SIZE;
      } else if (type == PKT_TYPE_CONTROL) {
        if (count == 0 || count > 16) {
          packetIndex = 0;
          packetExpected = 0;
          parseState = WAIT_SYNC1;
          return;
        }
        packetExpected = HEADER_SIZE + count + CHECKSUM_SIZE;
      } else {
        packetIndex = 0;
        packetExpected = 0;
        parseState = WAIT_SYNC1;
        return;
      }
    }

    if (packetExpected > 0 && packetIndex == packetExpected) {
      handleParsedPacket(packetBuffer, packetExpected);
      packetIndex = 0;
      packetExpected = 0;
      parseState = WAIT_SYNC1;
    }
    break;
  }
}

// ============================================================
// Services
// ============================================================

void serviceSerialRx() {
  while (Serial.available() > 0) {
    parseIncomingSerialByte((uint8_t)Serial.read());
  }
}

void serviceTxCapture() {
  if (!txActive)
    return;

  uint32_t now = micros();
  if ((uint32_t)(now - lastSampleMicros) < INTERVAL_US)
    return;

  lastSampleMicros += INTERVAL_US;

  uint16_t *activeBuf = fillA ? txBufA : txBufB;

  if ((fillA && txReadyA) || (!fillA && txReadyB)) {
    txOverflowCount++;
    return;
  }

  activeBuf[txFillIndex++] = (uint16_t)analogRead(ANALOG_PIN_IN);

  if (txFillIndex >= BLOCK_SIZE) {
    if (fillA) {
      txReadyA = true;
    } else {
      txReadyB = true;
    }
    fillA = !fillA;
    txFillIndex = 0;
  }
}

void serviceTxSend() {
  if (txReadyA) {
    sendSamplePacket(txBufA, BLOCK_SIZE);
    txReadyA = false;
  }

  if (txReadyB) {
    sendSamplePacket(txBufB, BLOCK_SIZE);
    txReadyB = false;
  }
}

void serviceRxPlayback() {
  uint16_t buffered = rxCount();

  if (rxPrebuffering) {
    if (buffered >= PREBUFFER_SAMPLES) {
      rxPrebuffering = false;
      rxPlaying = true;
      lastPlayMicros = micros();
    } else {
      analogWrite(DAC_PIN_OUT, lastDacOut);
      return;
    }
  }

  if (!rxPlaying)
    return;

  uint32_t now = micros();
  if ((uint32_t)(now - lastPlayMicros) < INTERVAL_US)
    return;

  lastPlayMicros += INTERVAL_US;

  uint16_t sample10;
  if (rxPop(sample10)) {
    uint16_t out12 = (uint16_t)(sample10 << 2);
    lastDacOut = out12;
    analogWrite(DAC_PIN_OUT, out12);
  } else {
    rxUnderrunCount++;
    rxPrebuffering = true;
    rxPlaying = false;
    analogWrite(DAC_PIN_OUT, lastDacOut);
  }
}

// ============================================================
// Arduino lifecycle
// ============================================================

void setup() {
  Serial.begin(1000000);

  analogReadResolution(10);
  analogWriteResolution(12);
  analogWrite(DAC_PIN_OUT, 0);

  txActive = false;
  rxClear();
}

void loop() {
  serviceSerialRx();
  serviceTxCapture();
  serviceTxSend();
  serviceRxPlayback();
}
