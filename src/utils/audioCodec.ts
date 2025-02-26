// Add a console log to confirm the module is being loaded
console.log('Audio codec module is loading...');

// Constants for audio encoding
const START_FREQUENCY = 1500; // Hz
const END_FREQUENCY = 2000; // Hz
const SYNC_FREQUENCY = 2200; // Hz
const BASE_DATA_FREQUENCY = 600; // Hz
const FREQUENCY_STEP = 100; // Hz step between hex digits
const HEX_DURATION = 0.08; // seconds (80ms per hex digit - slightly longer for better reception)
const SYNC_DURATION = 0.15; // seconds (longer sync duration)
const VOLUME = 0.9; // Slightly louder

// Even wider detection thresholds for better reception
const FREQUENCY_TOLERANCE = 200; // Hz tolerance for frequency detection (wider for better reception)
const SIGNAL_THRESHOLD = 50; // Lower threshold to detect quieter signals

// Debug flag to enable verbose logging
const DEBUG_AUDIO = true;

// State for decoding
let isReceivingMessage = false;
let messageBuffer: string[] = [];
let lastSyncTime = 0;
let isInSync = false;
let lastDetectedFrequency = 0;
let lastDetectedTime = 0;
let detectionDebounceTime = 30; // ms to avoid duplicate detections - shorter for better response
let endSignatureDetectionCount = 0; // Count of end signature detections
let lastDecodedMessage = ''; // Track last successfully decoded message

// Log direct to console for better debugging
const logMessage = (msg: string) => {
  if (DEBUG_AUDIO) {
    console.log(`%c${msg}`, 'color: #4a6bff; font-weight: bold;');
  }
};

/**
 * Check if AudioContext is usable and resume if needed
 */
const ensureAudioContextReady = async (audioContext: AudioContext): Promise<boolean> => {
  if (audioContext.state === 'closed') {
    console.error('AudioContext is closed and cannot be used');
    return false;
  }
  
  if (audioContext.state === 'suspended') {
    try {
      console.log('Resuming suspended AudioContext');
      await audioContext.resume();
      return audioContext.state !== 'suspended';
    } catch (error) {
      console.error('Failed to resume AudioContext:', error);
      return false;
    }
  }
  
  return true;
};

/**
 * Play a tone with the given frequency for the specified duration
 */
const playTone = async (
  audioContext: AudioContext,
  frequency: number,
  duration: number,
  startTime: number,
  volume: number = VOLUME
): Promise<number> => {
  // Ensure the context is ready
  const isReady = await ensureAudioContextReady(audioContext);
  if (!isReady) {
    console.error('Cannot play tone - AudioContext is not ready');
    return startTime; // Return current time without playing
  }
  
  // Create audio nodes
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  
  // Add fade in/out to avoid clicks
  const fadeTime = Math.min(0.005, duration / 10);
  
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(volume, startTime + fadeTime);
  gainNode.gain.setValueAtTime(volume, startTime + duration - fadeTime);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
  
  return startTime + duration;
};

/**
 * Play a distinct start pattern - make it more recognizable
 */
const playStartSignature = async (
  audioContext: AudioContext,
  startTime: number
): Promise<number> => {
  logMessage('Playing start signature');
  let currentTime = startTime;
  
  // Play a more complex start signature for better detection - increasing frequencies
  for (let i = 0; i < 3; i++) {
    currentTime = await playTone(
      audioContext, 
      START_FREQUENCY + (i * 100), 
      0.15, // Longer tones
      currentTime,
      0.95 // Louder
    );
    
    // Small gap between tones
    currentTime += 0.02;
  }
  
  return currentTime;
};

/**
 * Play an end signature pattern - make it more recognizable
 */
const playEndSignature = async (
  audioContext: AudioContext,
  startTime: number
): Promise<number> => {
  logMessage('Playing end signature');
  let currentTime = startTime;
  
  // Play a more complex end signature - decreasing frequencies
  for (let i = 0; i < 3; i++) {
    currentTime = await playTone(
      audioContext, 
      END_FREQUENCY - (i * 100), 
      0.15, // Longer tones
      currentTime,
      0.95 // Louder
    );
    
    // Small gap between tones
    currentTime += 0.02;
  }
  
  return currentTime;
};

/**
 * Play sync tone to maintain timing
 */
const playSyncTone = async (
  audioContext: AudioContext,
  startTime: number
): Promise<number> => {
  return await playTone(
    audioContext,
    SYNC_FREQUENCY,
    SYNC_DURATION,
    startTime,
    0.95 // Louder
  );
};

/**
 * Convert a hexadecimal digit to a frequency
 */
const hexToFrequency = (hex: string): number => {
  const hexValue = parseInt(hex, 16);
  return BASE_DATA_FREQUENCY + (hexValue * FREQUENCY_STEP);
};

/**
 * Convert a frequency back to a hexadecimal digit with more tolerance
 */
const frequencyToHex = (frequency: number): string | null => {
  if (frequency < BASE_DATA_FREQUENCY - FREQUENCY_TOLERANCE) return null;
  
  const hexValue = Math.round((frequency - BASE_DATA_FREQUENCY) / FREQUENCY_STEP);
  
  // Check if the value is in the valid hex range (0-15)
  if (hexValue >= 0 && hexValue <= 15) {
    return hexValue.toString(16).toLowerCase();
  }
  
  return null;
};

/**
 * Convert text to hexadecimal string
 */
const textToHex = (text: string): string => {
  let hex = '';
  
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    // Convert each character to a 2-digit hex representation
    hex += charCode.toString(16).padStart(2, '0');
  }
  
  return hex;
};

/**
 * Convert hexadecimal string back to text
 */
const hexToText = (hex: string): string => {
  let text = '';
  
  // Process 2 hex digits at a time (1 byte/character)
  for (let i = 0; i < hex.length; i += 2) {
    if (i + 1 < hex.length) {
      try {
        const charCode = parseInt(hex.substring(i, i + 2), 16);
        if (!isNaN(charCode) && charCode >= 32 && charCode <= 126) { // Printable ASCII
          text += String.fromCharCode(charCode);
        } else {
          text += '?'; // Replace non-printable with question mark
        }
      } catch (e) {
        text += '?'; // Replace invalid hex with question mark
      }
    }
  }
  
  return text;
};

/**
 * Calculate a checksum (XOR of all characters) for error detection
 */
const calculateChecksum = (text: string): string => {
  let checksum = 0;
  
  for (let i = 0; i < text.length; i++) {
    checksum ^= text.charCodeAt(i); // XOR operation
  }
  
  // Return as a 2-character hex string
  return checksum.toString(16).padStart(2, '0');
};

/**
 * Encode text to audio and play it - using hexadecimal encoding
 */
export const encodeText = async (
  text: string,
  audioContext: AudioContext
): Promise<void> => {
  return new Promise(async (resolve) => {
    // Ensure the audio context is ready
    const isReady = await ensureAudioContextReady(audioContext);
    if (!isReady) {
      console.error('Cannot encode text - AudioContext is not ready');
      resolve();
      return;
    }
    
    logMessage(`Encoding text: "${text}" using hexadecimal encoding`);
    const startTime = audioContext.currentTime;
    let currentTime = startTime;
    
    // Play start signature
    currentTime = await playStartSignature(audioContext, currentTime);
    currentTime += 0.2; // Pause after signature
    
    // Convert text to hex
    const hexData = textToHex(text);
    console.log(`Hex data (${hexData.length} digits):`, hexData);
    
    // Calculate checksum
    const checksum = calculateChecksum(text);
    console.log(`Checksum: ${checksum}`);
    const hexDataWithChecksum = hexData + checksum;
    
    // Play a sync tone before the data
    currentTime = await playSyncTone(audioContext, currentTime);
    currentTime += 0.05; // Small gap
    
    // Transmit hex data with sync tones for timing
    const digitsPerSync = 6; // Add sync tone more frequently (every 6 hex digits)
    for (let i = 0; i < hexDataWithChecksum.length; i++) {
      const hexDigit = hexDataWithChecksum[i];
      const frequency = hexToFrequency(hexDigit);
      
      console.log(`Transmitting hex digit ${hexDigit} at ${frequency}Hz`);
      
      // Play the hex tone
      currentTime = await playTone(audioContext, frequency, HEX_DURATION, currentTime);
      
      // Add a tiny gap between digits
      currentTime += 0.01;
      
      // Add sync tone periodically to maintain timing
      if ((i + 1) % digitsPerSync === 0 && i < hexDataWithChecksum.length - 1) {
        currentTime = await playSyncTone(audioContext, currentTime);
        currentTime += 0.02; // Gap after sync
      }
    }
    
    // Add a small pause before the end signature
    currentTime += 0.1;
    
    // Play end signature
    currentTime = await playEndSignature(audioContext, currentTime);
    
    const totalDuration = (currentTime - startTime) * 1000;
    logMessage(`Transmission complete, duration: ${totalDuration.toFixed(0)}ms`);
    
    // Resolve when the whole message is played
    setTimeout(() => resolve(), totalDuration);
  });
};

/**
 * NEW: Try to fix corrupted hex data if possible
 */
const attemptHexDataRecovery = (hexData: string): string => {
  // Make sure we have an even number of characters (hex digits always come in pairs)
  if (hexData.length % 2 !== 0) {
    hexData = hexData.slice(0, -1); // Remove the last character if odd
  }
  
  // Replace any invalid hex characters with '0'
  const fixedHex = hexData.replace(/[^0-9a-f]/gi, '0');
  
  return fixedHex;
};

/**
 * Detect signature patterns and decode frequencies to text
 */
export const decodeAudio = (
  frequencyData: Uint8Array,
  sampleRate: number
): string | null => {
  try {
    // Find the dominant frequency
    let maxBin = 0;
    let maxValue = 0;
    
    for (let i = 0; i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxBin = i;
      }
    }
    
    // If no significant audio, return null
    if (maxValue < SIGNAL_THRESHOLD) return null;
    
    // Calculate the actual frequency
    const binFrequency = maxBin * sampleRate / (frequencyData.length * 2);
    
    // Current time (approximation based on audio buffer frame)
    const currentTime = Date.now();
    
    // Debounce frequency detection to avoid duplicates
    if (Math.abs(binFrequency - lastDetectedFrequency) < 20 && 
        currentTime - lastDetectedTime < detectionDebounceTime) {
      return null;
    }
    
    // Update last detected frequency and time
    lastDetectedFrequency = binFrequency;
    lastDetectedTime = currentTime;
    
    // Check for start signature
    if (!isReceivingMessage && 
        Math.abs(binFrequency - START_FREQUENCY) < FREQUENCY_TOLERANCE && 
        maxValue > 90) {
      console.log('***** DETECTED START SIGNATURE *****');
      isReceivingMessage = true;
      messageBuffer = [];
      isInSync = false;
      return null;
    }
    
    // Check for sync tone
    if (isReceivingMessage && Math.abs(binFrequency - SYNC_FREQUENCY) < FREQUENCY_TOLERANCE) {
      console.log('Detected sync tone');
      lastSyncTime = currentTime;
      isInSync = true;
      return null;
    }
    
    // Process hex digits only if we're receiving
    if (isReceivingMessage) {
      // If too much time has passed since the last sync, we might be out of sync
      if (currentTime - lastSyncTime > 3000) { // 3 second timeout
        console.log('Lost sync due to timeout');
        isInSync = false;
      }
      
      // Check for hex frequency
      const hexDigit = frequencyToHex(binFrequency);
      if (hexDigit !== null) {
        console.log(`Detected hex digit: ${hexDigit} from frequency ${binFrequency.toFixed(0)}Hz`);
        
        // Only add hex digits that have a significant volume
        if (maxValue > 80) {
          messageBuffer.push(hexDigit);
        }
        return null;
      }
      
      // Check for end signature
      if (Math.abs(binFrequency - END_FREQUENCY) < FREQUENCY_TOLERANCE) {
        endSignatureDetectionCount++;
        
        // Require multiple detections for better reliability
        if (endSignatureDetectionCount >= 2) {
          console.log('***** DETECTED END SIGNATURE *****');
          isReceivingMessage = false;
          isInSync = false;
          endSignatureDetectionCount = 0;
          
          // If we have collected data, convert it to text
          if (messageBuffer.length > 0) {
            console.log(`Message buffer (${messageBuffer.length} digits): ${messageBuffer.join('')}`);
            
            // We need at least 4 characters (2 for text, 2 for checksum)
            if (messageBuffer.length >= 4) {
              const hexData = messageBuffer.join('');
              
              // Extract checksum (last 2 characters)
              const receivedChecksum = hexData.slice(-2);
              const dataHex = hexData.slice(0, -2);
              
              console.log(`Data hex: ${dataHex}, Checksum: ${receivedChecksum}`);
              
              try {
                // Fix any invalid hex data
                const cleanedHex = attemptHexDataRecovery(dataHex);
                
                // Convert to text
                const decodedText = hexToText(cleanedHex);
                
                // Check if the text looks valid
                if (!decodedText || !/^[\x20-\x7E]+$/.test(decodedText)) {
                  console.log(`Decoded text appears invalid: "${decodedText}"`);
                  messageBuffer = []; // Clear buffer
                  return null;
                }
                
                // Calculate checksum for the decoded text
                const calculatedChecksum = calculateChecksum(decodedText);
                
                console.log(`Decoded text: "${decodedText}", Calculated checksum: ${calculatedChecksum}`);
                
                // Avoid duplicate messages (can help if end signature detected multiple times)
                if (decodedText === lastDecodedMessage) {
                  console.log('Duplicate message detected, ignoring');
                  messageBuffer = []; // Clear buffer
                  return null;
                }
                
                // Allow checksum to match regardless of case
                if (receivedChecksum.toLowerCase() === calculatedChecksum.toLowerCase()) {
                  console.log('✅ Checksum verification passed');
                  console.log('Decoded message:', decodedText);
                  lastDecodedMessage = decodedText;
                  messageBuffer = []; // Clear buffer
                  
                  // Return the successfully decoded message
                  return decodedText;
                } else {
                  console.log(`❌ Checksum verification failed: received ${receivedChecksum}, calculated ${calculatedChecksum}`);
                  
                  // Try to recover message despite checksum failure
                  if (decodedText && decodedText.length > 0 && /^[\x20-\x7E]+$/.test(decodedText)) {
                    console.log('Message appears to be valid text despite checksum failure, returning anyway');
                    lastDecodedMessage = decodedText;
                    messageBuffer = []; // Clear buffer
                    return decodedText + " (checksum error)";
                  }
                  
                  messageBuffer = []; // Clear buffer
                }
              } catch (e) {
                console.error('Error decoding message:', e);
                messageBuffer = []; // Clear buffer
              }
            }
          }
        } else {
          console.log(`Potential end signature detected (${endSignatureDetectionCount}/2)`);
        }
      } else {
        // Reset counter if we're not seeing end frequencies
        endSignatureDetectionCount = 0;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error in decodeAudio:', error);
    return null;
  }
};

/**
 * Reset the decoder state (useful when starting new listening session)
 */
export const resetDecoder = () => {
  console.log('Resetting decoder state');
  isReceivingMessage = false;
  messageBuffer = [];
  lastSyncTime = 0;
  isInSync = false;
  lastDetectedFrequency = 0;
  lastDetectedTime = 0;
  endSignatureDetectionCount = 0;
  lastDecodedMessage = '';
};

/**
 * In a real implementation, we would need a more sophisticated algorithm that:
 * 1. Buffers and processes multiple frequency samples over time
 * 2. Uses signal processing to detect the start and end patterns
 * 3. Keeps track of timing to distinguish between digits
 * 4. Uses more robust error correction codes
 * 5. Implements adaptive frequency detection based on environmental conditions
 *
 * The simplified version above is for demonstration purposes only.
 */ 