// Add a console log to confirm the module is being loaded
console.log('Audio codec module is loading with enhanced character detection and faster transmission...');

// Constants for audio encoding
export const START_FREQUENCY = 2500; // Hz - higher and distinct
export const END_FREQUENCY = 2700; // Hz - higher and distinct
export const MINIMUM_VALID_FREQUENCY = 400; // Ignore all frequencies below this threshold
export const MAXIMUM_VALID_FREQUENCY = 8300; // Upper limit increased for wider character spacing (100Hz)

// Constants for timing - BALANCED FOR SPEED AND ACCURACY
const START_MARKER_DURATION = 0.12; // seconds - balanced for speed and reliability (up from 0.10s)
const END_MARKER_DURATION = 0.12; // seconds - balanced for speed and reliability (up from 0.10s)
const CHARACTER_DURATION = 0.07; // seconds - balanced for accuracy while still fast (up from 0.055s)
const CHARACTER_GAP = 0.03; // seconds - balanced for accuracy while still fast (up from 0.025s)
const VOLUME = 1.0; // Full volume for better reception

// Constants for parallel tone transmission
const USE_PARALLEL_TONES = true; // Enable parallel tones to improve detection at higher speeds
const PARALLEL_TONE_OFFSET = 35; // Hz offset for parallel tone - increased for better distinction at higher speeds
const PARALLEL_TONE_VOLUME = 0.75; // Slightly lower volume for secondary tone

// Detection thresholds - ADJUSTED FOR RELIABILITY
const FREQUENCY_TOLERANCE = 45; // Slightly reduced tolerance for better accuracy (down from 48)
const SIGNAL_THRESHOLD = 135; // Threshold balanced for speed and accuracy
const DEBOUNCE_TIME = 75; // Increased for better accuracy (up from 65ms)
const CHARACTER_LOCKOUT_TIME = 120; // Increased for better accuracy (up from 100ms)

// Debug flag to enable verbose logging
const DEBUG_AUDIO = true;

// We'll use a much simpler approach with wider spacing
// This maps each character to a specific frequency with wider spacing for problematic characters
const CHAR_FREQUENCIES: { [char: string]: number } = {
  // Space - keep at lower frequency as it's common (increased from 500)
  ' ': 900,  
  
  // Special characters - with increased spacing (100Hz apart)
  '!': 1300,
  '@': 1400,
  '#': 1500,
  '$': 1600,
  '%': 1700,
  '^': 1800,
  '&': 1900,
  '*': 2000,
  '(': 2100,
  ')': 2200,
  '-': 2300,
  '_': 2400,
  '+': 2600, // Skip START_FREQUENCY (2500)
  '=': 2800, // Skip END_FREQUENCY (2700)
  '{': 2900,
  '}': 3000,
  '[': 3100,
  ']': 3200,
  '|': 3300,
  '\\': 3400,
  ':': 3500,
  ';': 3600,
  '"': 3700,
  "'": 3800,
  '<': 3900,
  '>': 4000,
  ',': 4100,
  '.': 4200,
  '/': 4300,
  '?': 4400,
  '`': 4500,
  '~': 4600,
  
  // Numbers - 4700-5600Hz range (100Hz spacing)
  '0': 4700,
  '1': 4800,
  '2': 4900,
  '3': 5000,
  '4': 5100,
  '5': 5200,
  '6': 5300,
  '7': 5400,
  '8': 5500,
  '9': 5600,
  
  // Uppercase letters - 5700-8200Hz range (100Hz spacing)
  'A': 5700,
  'B': 5800,
  'C': 5900,
  'D': 6000,
  'E': 6100,
  'F': 6200,
  'G': 6300,
  'H': 6400,
  'I': 6500,
  'J': 6600,
  'K': 6700,
  'L': 6800,
  'M': 6900,
  'N': 7000,
  'O': 7100,
  'P': 7200,
  'Q': 7300,
  'R': 7400,
  'S': 7500,
  'T': 7600,
  'U': 7700,
  'V': 7800,
  'W': 7900,
  'X': 8000,
  'Y': 8100,
  'Z': 8200,
};

// Print frequency map size and ranges
console.log(`Initialized frequency map for ${Object.keys(CHAR_FREQUENCIES).length} characters`);
console.log('Frequency ranges:');
console.log('- Space: 900 Hz');
console.log('- Special characters: 1300-4600 Hz (100Hz spacing)');
console.log('- Numbers: 4700-5600 Hz (100Hz spacing)');
console.log('- START marker: 2500 Hz');
console.log('- END marker: 2700 Hz');
console.log('- Uppercase letters: 5700-8200 Hz (100Hz spacing)');

// State for decoding
let isReceivingMessage = false;
let messageBuffer: string = ''; // Store characters directly
let startMarkerDetectionCount = 0;
let endMarkerDetectionCount = 0;
let lastDetectedFrequency = 0;
let lastDetectedTime = 0;
let lastDetectedChar = '';
let transmissionStartTime = 0;
let recentCharacters: { char: string, time: number }[] = []; // Track recent character detections
let charFrequencyCounts: Map<string, number> = new Map(); // Count how many times we've seen each character

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
 * Balanced for better reliability while keeping good speed
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
  
  // Create audio nodes for primary tone
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  
  // Balanced fade times for reliability without sacrificing too much speed
  const fadeTime = Math.min(0.004, duration / 18); // Slightly longer fade for better reliability
  
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(volume, startTime + fadeTime);
  gainNode.gain.setValueAtTime(volume, startTime + duration - fadeTime);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
  
  // Add a parallel secondary tone if enabled (improves detection)
  if (USE_PARALLEL_TONES && frequency !== START_FREQUENCY && frequency !== END_FREQUENCY) {
    // Create a secondary tone with slight frequency offset for better detection
    const oscillator2 = audioContext.createOscillator();
    const gainNode2 = audioContext.createGain();
    
    oscillator2.type = 'sine';
    oscillator2.frequency.value = frequency + PARALLEL_TONE_OFFSET;
    
    gainNode2.gain.setValueAtTime(0, startTime);
    gainNode2.gain.linearRampToValueAtTime(PARALLEL_TONE_VOLUME, startTime + fadeTime);
    gainNode2.gain.setValueAtTime(PARALLEL_TONE_VOLUME, startTime + duration - fadeTime);
    gainNode2.gain.linearRampToValueAtTime(0, startTime + duration);
    
    oscillator2.connect(gainNode2);
    gainNode2.connect(audioContext.destination);
    
    oscillator2.start(startTime);
    oscillator2.stop(startTime + duration);
  }
  
  return startTime + duration;
};

/**
 * Convert a character to its corresponding frequency
 */
const charToFrequency = (char: string): number => {
  // Always use uppercase for consistent mapping
  const upperChar = char.toUpperCase();
  
  // Return the frequency for this character, or 0 if not supported
  return CHAR_FREQUENCIES[upperChar] || 0;
};

/**
 * Convert a frequency back to the original character
 */
const frequencyToChar = (frequency: number): string | null => {
  // Find the closest character within tolerance
  for (const [char, charFreq] of Object.entries(CHAR_FREQUENCIES)) {
    if (Math.abs(frequency - charFreq) < FREQUENCY_TOLERANCE) {
      return char;
    }
  }
  return null;
};

/**
 * Encode text into audio signals
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
    
    // Convert all text to uppercase to match our frequency mapping
    text = text.toUpperCase();
    
    logMessage(`Encoding text: "${text}" using optimized batch character encoding`);
    const startTime = audioContext.currentTime;
    let currentTime = startTime;
    
    // Add a small initial delay (balanced for reliability)
    currentTime += 0.03; // Increased slightly for better reliability (from 0.025s)
    
    // Play start marker - one shorter tone
    logMessage('Playing start marker');
    currentTime = await playTone(
      audioContext,
      START_FREQUENCY,
      START_MARKER_DURATION,
      currentTime,
      VOLUME
    );
    
    // Add gap after start marker
    currentTime += 0.03; // Increased slightly for better reliability (from 0.025s)
    
    // OPTIMIZATION: Pre-schedule all character tones at once with batch scheduling
    const characters = text.split('');
    
    // Define the type for our audio nodes
    type AudioNodeSet = {
      char: string;
      frequency: number;
      oscillator: OscillatorNode;
      gainNode: GainNode;
      oscillator2: OscillatorNode | null;
      gainNode2: GainNode | null;
    };
    
    // Create all oscillators and gain nodes first for more efficient scheduling
    const nodes: AudioNodeSet[] = characters
      .map(char => {
        const frequency = charToFrequency(char);
        
        if (frequency === 0) {
          console.warn(`Skipping unsupported character: '${char}'`);
          return null;
        }
        
        // Create nodes for this character
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // For parallel tones if enabled
        let oscillator2: OscillatorNode | null = null;
        let gainNode2: GainNode | null = null;
        
        if (USE_PARALLEL_TONES) {
          oscillator2 = audioContext.createOscillator();
          gainNode2 = audioContext.createGain();
          
          oscillator2.type = 'sine';
          oscillator2.frequency.value = frequency + PARALLEL_TONE_OFFSET;
          
          oscillator2.connect(gainNode2);
          gainNode2.connect(audioContext.destination);
        }
        
        return { 
          char, 
          frequency, 
          oscillator, 
          gainNode, 
          oscillator2, 
          gainNode2 
        };
      })
      .filter((node): node is AudioNodeSet => node !== null); // Type-safe filter to remove nulls
    
    // Now schedule all the tones in sequence with optimized timing
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const { char, frequency, oscillator, gainNode, oscillator2, gainNode2 } = node;
      
      // Optimized fade times for faster transmission
      const fadeTime = Math.min(0.005, CHARACTER_DURATION / 12); // Ultra-fast fade for quick tones
      
      // Schedule primary tone
      gainNode.gain.setValueAtTime(0, currentTime);
      gainNode.gain.linearRampToValueAtTime(VOLUME, currentTime + fadeTime);
      gainNode.gain.setValueAtTime(VOLUME, currentTime + CHARACTER_DURATION - fadeTime);
      gainNode.gain.linearRampToValueAtTime(0, currentTime + CHARACTER_DURATION);
      
      oscillator.start(currentTime);
      oscillator.stop(currentTime + CHARACTER_DURATION);
      
      // Schedule parallel tone if enabled
      if (USE_PARALLEL_TONES && oscillator2 && gainNode2) {
        gainNode2.gain.setValueAtTime(0, currentTime);
        gainNode2.gain.linearRampToValueAtTime(PARALLEL_TONE_VOLUME, currentTime + fadeTime);
        gainNode2.gain.setValueAtTime(PARALLEL_TONE_VOLUME, currentTime + CHARACTER_DURATION - fadeTime);
        gainNode2.gain.linearRampToValueAtTime(0, currentTime + CHARACTER_DURATION);
        
        oscillator2.start(currentTime);
        oscillator2.stop(currentTime + CHARACTER_DURATION);
      }
      
      // Display scheduling status periodically
      if (i % 5 === 0 || i === nodes.length - 1) {
        console.log(`Scheduling character '${char}' at ${frequency}Hz at time ${currentTime.toFixed(3)}`);
      }
      
      // Update the time for the next character
      currentTime += CHARACTER_DURATION + CHARACTER_GAP;
    }
    
    // Add pause before end marker
    currentTime += 0.03; // Increased slightly for better reliability (from 0.025s)
    
    // Play end marker - one shorter tone
    logMessage('Playing end marker');
    currentTime = await playTone(
      audioContext,
      END_FREQUENCY,
      END_MARKER_DURATION,
      currentTime,
      VOLUME
    );
    
    const totalDuration = (currentTime - startTime) * 1000;
    const charsPerSecond = text.length / ((totalDuration) / 1000);
    logMessage(`Transmission complete, duration: ${totalDuration.toFixed(0)}ms, speed: ${charsPerSecond.toFixed(1)} chars/sec`);
    
    // Resolve when the whole message is played with an appropriate buffer
    // This ensures the audio has completely finished playing before resolving
    const endBuffer = Math.max(100, totalDuration * 0.05); // Add 5% buffer or at least 100ms
    logMessage(`Waiting ${endBuffer.toFixed(0)}ms for audio to complete...`);
    
    setTimeout(() => {
      logMessage('Transmission fully complete');
      resolve();
    }, totalDuration + endBuffer);
  });
};

/**
 * Enhanced character deduplication and filtering system
 * Balanced for optimal speed and accuracy
 */
const shouldAddCharacter = (char: string): boolean => {
  const now = Date.now();
  
  // Clean up old character detections - balanced time window
  recentCharacters = recentCharacters.filter(entry => (now - entry.time) < 450); // Increased window for better reliability
  
  // Strategy 1: Simple time-based debounce with balanced lockout time
  // If we've seen this exact character recently, reject it
  for (const entry of recentCharacters) {
    if (entry.char === char && (now - entry.time) < CHARACTER_LOCKOUT_TIME) {
      console.log(`Rejecting duplicate '${char}' - detected ${now - entry.time}ms ago`);
      return false;
    }
  }
  
  // Strategy 2: Check for unusual frequency - balanced approach
  let consecutiveCount = 0;
  const recentCharsToCheck = Math.min(recentCharacters.length, 4); // Check more characters for better accuracy
  
  for (let i = recentCharacters.length - 1; i >= recentCharacters.length - recentCharsToCheck; i--) {
    if (i < 0) break; // Safety check
    if (recentCharacters[i].char === char) {
      consecutiveCount++;
      // Only filter consecutive identical characters (except space and common letters) 
      if (consecutiveCount >= 3 && char !== ' ' && !isCommonRepeatingChar(char)) {
        console.log(`Rejecting unusual frequency of character '${char}'`);
        return false;
      }
    } else {
      break;
    }
  }
  
  // Special treatment for tricky punctuation/special characters
  // Balance between speed and accuracy
  if (char.match(/[-_+=$&@#%^*(){}[\]|\\:;"'<>,.?/]/)) {
    // More careful with special characters
    for (const entry of recentCharacters) {
      if (entry.char === char && (now - entry.time) < 350) { // Increased from 300ms for better accuracy
        console.log(`Rejecting duplicate special character '${char}'`);
        return false;
      }
    }
  }
  
  // Add this character to our recent detections
  recentCharacters.push({ char, time: now });
  return true; // Not a duplicate based on our strategies
};

/**
 * Helper function to identify characters that commonly repeat in text
 */
const isCommonRepeatingChar = (char: string): boolean => {
  // Allow repeats for letters that commonly repeat: E, L, O, T, etc.
  return ['E', 'L', 'O', 'T', 'M', 'S', 'P', 'A'].includes(char);
};

/**
 * Process received message to improve accuracy
 * Applies various rules to clean up the message
 */
const postProcessMessage = (message: string): string => {
  return message;
};

/**
 * Detect signature patterns and decode frequencies to text
 */
export const decodeAudio = (
  frequencyData: Uint8Array,
  sampleRate: number
): string | null => {
  try {
    // Find the dominant frequency with a simple algorithm
    let maxBin = 0;
    let maxValue = 0;
    
    for (let i = 0; i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxBin = i;
      }
    }
    
    // If no significant audio or below our threshold, return null
    if (maxValue < SIGNAL_THRESHOLD) return null;
    
    // Calculate the actual frequency
    const binFrequency = maxBin * sampleRate / (frequencyData.length * 2);
    
    // Filter out frequencies that are too low or too high
    if (binFrequency < MINIMUM_VALID_FREQUENCY || binFrequency > MAXIMUM_VALID_FREQUENCY) {
      // Only log if it's a significant signal
      if (maxValue > SIGNAL_THRESHOLD + 50) {
        console.log(`Ignoring out-of-range frequency: ${binFrequency.toFixed(0)}Hz (${maxValue})`);
      }
      return null;
    }
    
    // Current time (approximation based on audio buffer frame)
    const currentTime = Date.now();
    
    // Improved debounce frequency detection
    if (Math.abs(binFrequency - lastDetectedFrequency) < 15 && 
        currentTime - lastDetectedTime < DEBOUNCE_TIME) {
      return null;
    }
    
    // Debug logs for all significant detections
    if (maxValue > SIGNAL_THRESHOLD) {
      // Update last detected frequency and time
      lastDetectedFrequency = binFrequency;
      lastDetectedTime = currentTime;
    }
    
    // Check for timeout (15 seconds) if we're receiving a message - reduced from 20s
    if (isReceivingMessage && (currentTime - transmissionStartTime > 15000)) {
      console.log('⚠️ TRANSMISSION TIMEOUT - Force ending after 15 seconds');
      const message = messageBuffer;
      
      // Reset state
      isReceivingMessage = false;
      messageBuffer = '';
      
      // Reset character tracking
      charFrequencyCounts.clear();
      
      // Return what we have with a timeout marker
      if (message.length > 0) {
        return "[STREAM_END] " + message + " (timeout)";
      }
      
      return "[STREAM_END] (timeout)";
    }
    
    // Check for start marker with improved accuracy
    if (!isReceivingMessage && 
        Math.abs(binFrequency - START_FREQUENCY) < FREQUENCY_TOLERANCE && 
        maxValue > SIGNAL_THRESHOLD) {
      
      // Count start marker detections for better reliability
      startMarkerDetectionCount++;
      
      console.log(`Potential start marker detected (${startMarkerDetectionCount}/2), freq: ${binFrequency.toFixed(0)}Hz, strength: ${maxValue}`);
      
      // Require 2 detections for better reliability
      if (startMarkerDetectionCount >= 2) { // Increased from 1 to 2 for better reliability
        console.log('***** DETECTED START MARKER *****');
        isReceivingMessage = true;
        messageBuffer = '';
        transmissionStartTime = currentTime;
        startMarkerDetectionCount = 0;
        recentCharacters = []; // Clear recent characters
        charFrequencyCounts.clear(); // Reset character counts
        
        // Return a special marker for the UI to indicate streaming is starting
        return "[STREAM_START]";
      }
      return null;
    } else if (!isReceivingMessage) {
      // Reset counter if we're not seeing start frequencies
      startMarkerDetectionCount = 0;
    }
    
    // Check for end marker with improved accuracy
    if (isReceivingMessage && 
        Math.abs(binFrequency - END_FREQUENCY) < FREQUENCY_TOLERANCE && 
        maxValue > SIGNAL_THRESHOLD) {
      
      endMarkerDetectionCount++;
      
      console.log(`Potential end marker detected (${endMarkerDetectionCount}/2), freq: ${binFrequency.toFixed(0)}Hz, strength: ${maxValue}`);
      
      // Require 2 detections for better reliability
      if (endMarkerDetectionCount >= 2) { // Increased from 1 to 2 for better reliability
        console.log('***** DETECTED END MARKER *****');
        
        // Store the message and reset state
        const message = messageBuffer;
        isReceivingMessage = false;
        messageBuffer = '';
        endMarkerDetectionCount = 0;
        recentCharacters = []; // Clear recent characters
        charFrequencyCounts.clear(); // Reset character counts
        
        // Apply post-processing to improve message quality
        const processedMessage = postProcessMessage(message);
        
        // If we have a message, return it
        if (processedMessage.length > 0) {
          console.log(`Decoded message: "${processedMessage}"`);
          return "[STREAM_END] " + processedMessage;
        }
        
        return "[STREAM_END]";
      }
      return null;
    } else if (isReceivingMessage) {
      // Reset counter if we're not seeing end frequencies
      endMarkerDetectionCount = 0;
      
      // Process character frequencies if we're receiving a message
      // and the frequency is within our valid character range
      if (binFrequency >= MINIMUM_VALID_FREQUENCY && binFrequency <= MAXIMUM_VALID_FREQUENCY) {
        const char = frequencyToChar(binFrequency);
        
        if (char !== null) {
          // Ensure the character is uppercase
          const upperChar = char.toUpperCase();
          
          console.log(`Detected character: '${upperChar}' from frequency ${binFrequency.toFixed(0)}Hz, strength: ${maxValue}`);
          
          // Use enhanced character filtering
          if (shouldAddCharacter(upperChar)) {
            console.log(`Adding character '${upperChar}' to message buffer`);
            messageBuffer += upperChar;
            lastDetectedChar = upperChar;
            
            // Return a streaming update with the new character
            return "[STREAM]" + upperChar;
          } else {
            console.log(`Filtered out potential duplicate: '${upperChar}'`);
          }
        }
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
  console.log('Decoder reset');
  isReceivingMessage = false;
  messageBuffer = '';
  startMarkerDetectionCount = 0;
  endMarkerDetectionCount = 0;
  lastDetectedFrequency = 0;
  lastDetectedTime = 0;
  lastDetectedChar = '';
  transmissionStartTime = 0;
  recentCharacters = [];
  charFrequencyCounts.clear();
};