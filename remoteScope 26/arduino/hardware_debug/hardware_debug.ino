// 🛠️ LabLink DAC Hardware Diagnostic Test
// Flashing this will immediately generate a PERFECT smooth 100Hz Sine Wave out of Pin A0 (DAC)
// If this still looks noisy on your lab oscilloscope, perfectly clean your probes and attach the Oscilloscope Ground!

const int DAC_PIN = A0;
float phase = 0.0;
const float FREQUENCY = 100.0; // 100 Hz wave
const int SAMPLE_RATE = 10000;
const unsigned long INTERVAL_US = 1000000 / SAMPLE_RATE;
unsigned long lastTick = 0;

void setup() {
  analogWriteResolution(12); // Activate 12-bit native DAC
}

void loop() {
  unsigned long currentMicros = micros();
  if (currentMicros - lastTick >= INTERVAL_US) {
    lastTick += INTERVAL_US;
    
    // Generate a beautiful 12-bit sine wave mathematically! (0 to 4095 range)
    float sineVal = sin(phase) * 2047.0 + 2047.0;
    
    // Cast strictly to integer and blast it out the DAC
    analogWrite(DAC_PIN, (int)sineVal);
    
    // Advance phase smoothly
    phase += (2.0 * PI * FREQUENCY) / SAMPLE_RATE;
    if (phase >= 2.0 * PI) {
      phase -= 2.0 * PI;
    }
  }
}
