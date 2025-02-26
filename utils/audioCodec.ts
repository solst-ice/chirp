// Audio Codec for Chirp Application
console.log('Loading audio codec module');

// OPTIMIZED CONSTANTS - significantly faster encoding
// ===================================================
export const START_FREQUENCY = 3800; // Start signature tone
export const END_FREQUENCY = 4000;   // End signature tone  
export const SYNC_FREQUENCY = 3600;  // Sync tone

// Optimized for speed - use 8 base frequencies for parallel transmission (3 bits at once)
export const BASE_FREQUENCIES = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];

// Much shorter tone durations for faster transmission
export const TONE_DURATION = 0.03;   // 30ms per tone (was likely ~100ms)
export const SYNC_DURATION = 0.02;   // 20ms for sync tones
export const SIG_DURATION = 0.05;    // 50ms for signature tones
export const VOLUME = 0.2;           // Moderate volume

// Wider detection to ensure reliable decoding with faster tones
export const FREQUENCY_TOLERANCE = 200;  // Hz tolerance for frequency detection
export const SIGNAL_THRESHOLD = 50;     // Minimum amplitude to consider a signal

// Completely disable ALL debug logging
const DEBUG = false;
export function logMessage(msg: string) {
  // Don't log anything
}

// Message buffer state
let messageBuffer = '';
let isReceivingMessage = false;
let lastDetectedFreq = 0;
let signatureCounter = 0;
let lastSignatureTime = 0;

// Reset the decoder state
export function resetDecoder() {
  messageBuffer = '';
  isReceivingMessage = false;
  lastDetectedFreq = 0;
  signatureCounter = 0;
  lastSignatureTime = 0;
  // No logging
}

// Ensure audio context is ready
export async function ensureAudioContextReady(audioContext: AudioContext) {
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  return audioContext;
}

// Function to play a tone
export function playTone(frequency: number, duration: number, volume: number, audioContext: AudioContext): Promise<void> {
  return new Promise((resolve) => {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    
    gainNode.gain.value = volume;
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.start();
    
    // Schedule precise stopping
    oscillator.stop(audioContext.currentTime + duration);
    
    // Resolve the promise after the tone finishes
    setTimeout(() => {
      resolve();
    }, duration * 1000);
  });
}

// Play start signature
export async function playStartSignature(audioContext: AudioContext): Promise<void> {
  // Removed debug log
  await playTone(START_FREQUENCY, SIG_DURATION, VOLUME, audioContext);
}

// Play end signature
export async function playEndSignature(audioContext: AudioContext): Promise<void> {
  // Removed debug log
  await playTone(END_FREQUENCY, SIG_DURATION, VOLUME, audioContext);
}

// Play sync tone
export async function playSyncTone(audioContext: AudioContext): Promise<void> {
  await playTone(SYNC_FREQUENCY, SYNC_DURATION, VOLUME, audioContext);
}

// OPTIMIZED: Binary encoding for efficiency - encodes 3 bits per tone
export function binaryToFrequency(bits: number): number {
  // Use the 3 bits to select one of 8 frequencies
  return BASE_FREQUENCIES[bits & 0x7]; // 0-7
}

export function frequencyToBinary(freq: number): number | null {
  // Find the closest frequency
  let minDiff = Infinity;
  let closestIndex = -1;
  
  for (let i = 0; i < BASE_FREQUENCIES.length; i++) {
    const diff = Math.abs(freq - BASE_FREQUENCIES[i]);
    if (diff < minDiff && diff < FREQUENCY_TOLERANCE) {
      minDiff = diff;
      closestIndex = i;
    }
  }
  
  return closestIndex !== -1 ? closestIndex : null;
}

// Convert a character to a binary value
function charToBinary(char: string): number {
  return char.charCodeAt(0);
}

// Convert a binary value to a character
function binaryToChar(binary: number): string {
  return String.fromCharCode(binary);
}

// OPTIMIZED: Fast text to audio encoding - encodes 3 bits at once
export async function encodeText(text: string, audioContext: AudioContext): Promise<void> {
  // Ensure consistent audio context state
  await ensureAudioContextReady(audioContext);
  
  // Calculate a simple checksum for error detection
  const checksum = calculateChecksum(text);
  
  // Add checksum to text
  const textWithChecksum = `${text}#${checksum}`;
  // Removed detailed debug log
  console.log(`Encoding message (${text.length} chars)`);
  
  // Play start signature
  await playStartSignature(audioContext);
  
  // OPTIMIZED APPROACH: 3 bits per tone
  const bytes: number[] = [];
  for (let i = 0; i < textWithChecksum.length; i++) {
    bytes.push(charToBinary(textWithChecksum[i]));
  }
  
  for (let byte of bytes) {
    // Encode each byte as 3 tones (3 bits per tone)
    const highBits = (byte >> 6) & 0x7;  // Bits 7-5
    const midBits = (byte >> 3) & 0x7;   // Bits 4-2
    const lowBits = byte & 0x7;          // Bits 1-0 (only using 3 bits)
    
    // Play the 3 tones in sequence
    await playTone(binaryToFrequency(highBits), TONE_DURATION, VOLUME, audioContext);
    await playSyncTone(audioContext);
    
    await playTone(binaryToFrequency(midBits), TONE_DURATION, VOLUME, audioContext);
    await playSyncTone(audioContext);
    
    await playTone(binaryToFrequency(lowBits), TONE_DURATION, VOLUME, audioContext);
    
    // Slight pause between characters but no sync tone needed between characters
  }
  
  // Play end signature
  await playEndSignature(audioContext);
  console.log('Encoding complete');
}

// Calculate a simple checksum for error detection
function calculateChecksum(text: string): string {
  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    sum = (sum + text.charCodeAt(i)) % 256;
  }
  return sum.toString(16).padStart(2, '0');
}

// Check if checksum matches
function isChecksumValid(text: string, checksum: string): boolean {
  const calculatedChecksum = calculateChecksum(text);
  return calculatedChecksum.toLowerCase() === checksum.toLowerCase();
}

// Attempt to recover text from corrupted hex
function recoverText(hex: string): string | null {
  try {
    // Split the hex string into pairs
    const pairs = [];
    for (let i = 0; i < hex.length; i += 2) {
      if (i + 1 < hex.length) {
        pairs.push(hex.substring(i, i + 2));
      } else {
        pairs.push(hex.substring(i, i + 1) + '0');
      }
    }
    
    // Convert hex pairs to characters
    return pairs.map(pair => {
      try {
        return String.fromCharCode(parseInt(pair, 16));
      } catch {
        return '?';
      }
    }).join('');
  } catch {
    return null;
  }
}

// Decode frequencies to binary and text
export function decodeAudio(frequencyData: Uint8Array, sampleRate: number): string | null {
  const fftSize = frequencyData.length * 2;
  const binWidth = sampleRate / fftSize;
  
  // Find the dominant frequency
  let maxBin = 0;
  let maxValue = 0;
  
  for (let i = 0; i < frequencyData.length; i++) {
    if (frequencyData[i] > maxValue) {
      maxValue = frequencyData[i];
      maxBin = i;
    }
  }
  
  // Check if signal is strong enough
  if (maxValue < SIGNAL_THRESHOLD) {
    return null;
  }
  
  // Calculate the dominant frequency without logging it
  const dominantFrequency = maxBin * binWidth;
  lastDetectedFreq = dominantFrequency;
  
  // IMPORTANT: Remove ALL console.log statements related to frequencies
  
  // Detect start signature
  if (!isReceivingMessage && 
      Math.abs(dominantFrequency - START_FREQUENCY) < FREQUENCY_TOLERANCE) {
    
    // Only start a new message if enough time has passed since the last signature
    const now = Date.now();
    if (now - lastSignatureTime > 500) {
      isReceivingMessage = true;
      messageBuffer = '';
      signatureCounter = 0;
      lastSignatureTime = now;
      // No logging
    }
    return null;
  }
  
  // Detect end signature without logging
  if (isReceivingMessage && 
      Math.abs(dominantFrequency - END_FREQUENCY) < FREQUENCY_TOLERANCE) {
    
    signatureCounter++;
    
    // Require multiple end signatures to ensure it's not a false detection
    if (signatureCounter >= 2) {
      isReceivingMessage = false;
      lastSignatureTime = Date.now();
      
      if (messageBuffer.length === 0) {
        return null;
      }
      
      // No buffer logging
      
      // Process the message buffer into bytes
      let collectedBinary: number[] = [];
      let currentByte = 0;
      let bitPosition = 0;
      
      for (let i = 0; i < messageBuffer.length; i++) {
        const bit = parseInt(messageBuffer[i]);
        if (!isNaN(bit)) {
          // Shift in 3 bits at a time
          currentByte = (currentByte << 3) | bit;
          bitPosition += 3;
          
          // When we have a full byte
          if (bitPosition >= 8) {
            collectedBinary.push(currentByte & 0xFF);
            currentByte = 0;
            bitPosition = 0;
          }
        }
      }
      
      // Convert binary to text
      let decodedText = '';
      for (let binary of collectedBinary) {
        decodedText += binaryToChar(binary);
      }
      
      // Look for checksum separator
      const checksumIndex = decodedText.lastIndexOf('#');
      if (checksumIndex !== -1) {
        const text = decodedText.substring(0, checksumIndex);
        const checksum = decodedText.substring(checksumIndex + 1);
        
        if (isChecksumValid(text, checksum)) {
          // Only log the successful decode, not the actual text content
          console.log(`Successfully decoded message (${text.length} chars)`);
          return text;
        } else {
          console.log(`Checksum validation failed. Attempting recovery.`);
          // Return the text anyway, might be usable
          return `[RECOVERED] ${text}`;
        }
      }
      
      return null;
    }
    return null;
  }
  
  // Reset signature counter when not seeing an end signature
  if (isReceivingMessage && 
      Math.abs(dominantFrequency - END_FREQUENCY) >= FREQUENCY_TOLERANCE) {
    signatureCounter = 0;
  }
  
  // Detect data frequencies when receiving
  if (isReceivingMessage) {
    // Skip sync tones
    if (Math.abs(dominantFrequency - SYNC_FREQUENCY) < FREQUENCY_TOLERANCE) {
      return null;
    }
    
    // Try to decode to binary without logging
    const binaryValue = frequencyToBinary(dominantFrequency);
    if (binaryValue !== null) {
      messageBuffer += binaryValue.toString();
      return null;
    }
  }
  
  return null;
} 