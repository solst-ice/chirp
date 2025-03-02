import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './App.css';
import FrequencyVisualizer from './components/FrequencyVisualizer';
import { 
  encodeText, 
  decodeAudio, 
  resetDecoder, 
  MAXIMUM_VALID_FREQUENCY 
} from './utils/audioCodec';

// Add a console log to confirm the component is loading
console.log('Chirp system initializing');

// Audio signal favicon SVG data - base64 encoded for direct use
const AUDIO_FAVICON = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij4KICA8cmVjdCB4PSIwIiB5PSIwIiB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiMxMzEzMTMiLz4KICA8IS0tIFRocmVlIHNpZ25hbCBiYXJzIHdpdGggc29saWQgY29sb3JzIC0tPgogIDxyZWN0IHg9IjEyIiB5PSI0MiIgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiByeD0iMiIgZmlsbD0iI2ZmNDFiNCIvPiA8IS0tIFBpbmsgLS0+CiAgPHJlY3QgeD0iMjciIHk9IjMwIiB3aWR0aD0iMTAiIGhlaWdodD0iMjIiIHJ4PSIyIiBmaWxsPSIjMDBmZmFhIi8+IDwhLS0gR3JlZW4gLS0+CiAgPHJlY3QgeD0iNDIiIHk9IjE4IiB3aWR0aD0iMTAiIGhlaWdodD0iMzQiIHJ4PSIyIiBmaWxsPSIjMzE4NWZmIi8+IDwhLS0gQmx1ZSAtLT4KPC9zdmc+`;

function App() {
  const [inputText, setInputText] = useState('');
  const [receivedMessage, setReceivedMessage] = useState('');
  const [isListening, setIsListening] = useState(true);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [frequencies, setFrequencies] = useState<number[]>([]);
  const [debugText, setDebugText] = useState<string>('Initializing system...');
  const [debugMode, setDebugMode] = useState<boolean>(false);
  const [transmitVisualization, setTransmitVisualization] = useState<boolean>(false);
  const [txStats, setTxStats] = useState<{
    charCount: number;
    duration: number;
    charsPerSecond: number;
  } | null>(null);
  
  // Add a state variable to track if initial message has been shown
  const [initialMessageShown, setInitialMessageShown] = useState<boolean>(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isListeningRef = useRef<boolean>(false); 
  const receivedMessagesRef = useRef<Set<string>>(new Set());
  const transmissionStartTime = useRef<number>(0);
  const lastReceivedTextRef = useRef<string | null>(null);
  const lastReceivedTimeRef = useRef<number>(0);
  const debugMsgCountRef = useRef<number>(0);
  const [forceUpdate, setForceUpdate] = useState<number>(0);
  const visualizerUpdateCountRef = useRef<number>(0);
  const [directUI, setDirectUI] = useState<boolean>(true); // Enable direct UI updates
  const messageDisplayRef = useRef<HTMLDivElement | null>(null);
  const [useMockData, setUseMockData] = useState<boolean>(false); // Add mock data option
  const [compatibilityMode, setCompatibilityMode] = useState<boolean>(true);
  const [sendTestMessages, setSendTestMessages] = useState<boolean>(false);
  const [systemInitialized, setSystemInitialized] = useState<boolean>(false);

  // For managing streaming messages
  const [isCurrentlyStreaming, setIsCurrentlyStreaming] = useState<boolean>(false);
  const currentStreamingText = useRef<string>('');
  
  // Add this ref to track transmission state globally
  const isActivelyTransmittingRef = useRef<boolean>(false);
  
  // Add a special ref just for sent messages that won't get overwritten
  const sentMessagesContainerRef = useRef<HTMLDivElement | null>(null);
  
  // Add useEffect to load the custom font stylesheet
  useEffect(() => {
    // Create a style element to add the @font-face declaration
    const style = document.createElement('style');
    style.textContent = `
      @font-face {
        font-family: 'Unifont';
        src: url('./unifont.woff') format('woff');
        font-weight: normal;
        font-style: normal;
        font-display: swap;
      }

      /* Apply the font to the entire app */
      body, input, button, textarea {
        font-family: 'Unifont', monospace;
      }
      
      /* Ensure the font is applied to all text elements in the app */
      .app-container,
      .title-container,
      .section-title,
      .controls button,
      .debug-container,
      .debug-info,
      .floating-stats-container,
      .status-indicator,
      .visualizer-container,
      .message-container,
      .transmit-container,
      .app-footer,
      
      /* Message display elements */
      .received-message,
      .received-message *,
      .message-line,
      .streaming-message,
      .timestamp,
      .message-separator,
      .sent-message,
      .timeout-message,
      .terminal-cursor {
        font-family: 'Unifont', monospace;
      }
      
      /* Direct style for dynamically inserted content */
      div[data-testid="message-display"] {
        font-family: 'Unifont', monospace !important;
      }
      
      /* Force the font on all elements as a fallback */
      * {
        font-family: 'Unifont', monospace;
      }
      
      /* HIGHEST PRIORITY SENT MESSAGE STYLING */
      .sent-message,
      [data-sent="true"],
      [class*="sent-indicator"],
      .sent-text,
      div:has([class*="sent-indicator"]),
      div:has(.sent-text) {
        color: var(--terminal-green) !important;
        text-shadow: 0 0 5px rgba(0, 255, 65, 0.3) !important;
      }
      
      /* Target specific elements with inline style */
      .message-line.sent-message,
      .message-line.sent-message *,
      .message-line[data-sent="true"],
      .message-line[data-sent="true"] * {
        color: var(--terminal-green) !important;
      }
    `;
    document.head.appendChild(style);
    
    console.log('Custom Unifont font loaded and applied app-wide');
    
    // Add a second style element with absolute highest priority
    const sentStyle = document.createElement('style');
    sentStyle.setAttribute('id', 'sent-message-styles');
    sentStyle.textContent = `
      /* Inline styles for maximum specificity */
      .sent-message,
      [data-sent="true"],
      [class*="sent-indicator"],
      .sent-text,
      div:has([class*="sent-indicator"]),
      div:has(.sent-text) {
        color: var(--terminal-green) !important;
        text-shadow: 0 0 5px rgba(0, 255, 65, 0.3) !important;
      }
      
      /* Target specific elements with inline style */
      .message-line.sent-message,
      .message-line.sent-message *,
      .message-line[data-sent="true"],
      .message-line[data-sent="true"] * {
        color: var(--terminal-green) !important;
      }
    `;
    document.head.appendChild(sentStyle);
    
    console.log('Added highest-priority sent message styles directly to document head');
  }, []);

  // Function to initialize or resume audio context - don't create until needed
  const getAudioContext = async () => {
    // If no context exists, create a new one
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
      analyserRef.current.smoothingTimeConstant = 0.5; // Even less smoothing for better detection
    }
    
    // If context is suspended, resume it
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    
    return audioContextRef.current;
  };
  
  // Clean up function for audio resources
  useEffect(() => {
    return () => {
      // Cancel any animation frame
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (analyserRef.current) {
        analyserRef.current.disconnect();
      }
    };
  }, []);

  // Update isListeningRef when isListening changes
  useEffect(() => {
    isListeningRef.current = isListening;
    
    // If we stopped listening, cancel the animation frame
    if (!isListening && animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      setDebugText('Listening stopped');
    }
    
    // Reset decoder when we start listening
    if (isListening) {
      resetDecoder();
      setReceivedMessage(''); // Clear the message display
      receivedMessagesRef.current.clear(); // Clear the received messages set
      lastReceivedTextRef.current = null;
      lastReceivedTimeRef.current = 0;
      debugMsgCountRef.current = 0;
      setDebugText('Listening started - waiting for audio...');
    }
  }, [isListening]);
  
  /**
   * Format a message with timestamp and appropriate styling
   */
  const formatMessage = (message: string, type: string): string => {
    const timestamp = new Date().toLocaleTimeString();
    
    // Add the appropriate class based on message type
    let className = '';
    
    if (type === 'sent') {
      className = 'sent-message';
    } else if (type === 'streaming') {
      className = 'streaming-message';
      // MODIFIED: Allow special characters in streaming messages
      // Only filter out control characters
      message = message.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
    } else if (type === 'timeout') {
      className = 'timeout-message';
    } else {
      className = 'received-message';
    }
    
    // Special handling for sent messages to ensure consistency
    if (message.includes("[SENT]")) {
      const timestamp = message.match(/\[\d{2}:\d{2}:\d{2}\]/);
      let cleanMessage = message;
      
      if (timestamp) {
        // Extract the part after [SENT]
        const sentParts = message.split("[SENT]");
        if (sentParts.length > 1) {
          const messageContent = sentParts[1].trim();
          // Create a simpler format with direct styling
          cleanMessage = `<div class="sent-message-direct" style="color: #00ff41; border-left: 4px solid #00ff41; background-color: rgba(0, 20, 0, 0.4); padding-left: 8px;">${timestamp[0]} <strong class="sent-indicator" style="color: #00ff41;">[SENT]</strong> ${messageContent}</div>`;
          
          console.log("Using ultra-simplified sent message format:", cleanMessage);
          return cleanMessage;
        }
      }
    }
    
    // Format with timestamp on a new line
    return `<div class="${className}">
      <div>${message}</div>
      <div class="timestamp">${timestamp}</div>
    </div>`;
  };

  // Function to directly update UI with a received message
  const addReceivedMessage = (message: string, isStreamingMessage = false) => {
    // Only log actual messages, not empty ones
    if (message.trim()) {
      console.log('Message received for display:', message, isStreamingMessage ? '(streaming)' : '');
    }
    
    // Create timestamp with current time
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    // Log timestamp for debugging
    console.log(`Adding timestamp [${timestamp}] to message`);
    
    // Check if this is a sent message
    const isSentMessage = message.includes('[SENT]');
    
    // For sent messages, use a completely separate DOM element that won't get overwritten
    if (isSentMessage && sentMessagesContainerRef.current) {
      console.log('Adding message to SENT messages container to prevent overwriting');
      
      // Create a div for the sent message with inline styles
      const sentMessageDiv = document.createElement('div');
      sentMessageDiv.classList.add('message-line', 'sent-message');
      sentMessageDiv.setAttribute('data-sent', 'true');
      sentMessageDiv.setAttribute('data-permanent-sent', 'true');
      
      // Apply all styles inline for maximum resilience
      sentMessageDiv.style.color = '#00ff41';
      sentMessageDiv.style.fontWeight = 'bold';
      sentMessageDiv.style.textShadow = '0 0 5px rgba(0, 255, 65, 0.3)';
      sentMessageDiv.style.borderLeft = '4px solid #00ff41';
      sentMessageDiv.style.backgroundColor = 'rgba(0, 20, 0, 0.4)';
      sentMessageDiv.style.marginBottom = '8px';
      sentMessageDiv.style.padding = '4px 8px';
      
      // Extract the message content after [SENT]
      let cleanMessage = message;
      if (message.startsWith('[SENT]:')) {
        cleanMessage = message.replace('[SENT]:', '').trim();
      } else if (message.startsWith('[SENT]')) {
        cleanMessage = message.replace('[SENT]', '').trim();
      }
      
      // Create content with green color applied to every element
      sentMessageDiv.innerHTML = `<span style="color: #00ff41;">[${timestamp}] <strong class="sent-indicator" style="color: #00ff41; font-weight: bold;">[SENT]</strong> <span class="sent-text" style="color: #00ff41;">${cleanMessage}</span></span>`;
      
      // Insert at the top of the sent messages container
      if (sentMessagesContainerRef.current.firstChild) {
        sentMessagesContainerRef.current.insertBefore(sentMessageDiv, sentMessagesContainerRef.current.firstChild);
      } else {
        sentMessagesContainerRef.current.appendChild(sentMessageDiv);
      }
      
      console.log('Added sent message to isolated container', sentMessageDiv);
      
      // Skip the normal message flow for sent messages
      return;
    }
    
    // Always create a consistent format with visible timestamp
    let formattedMessage = '';
    
    // Handle streaming message - use a special class for in-progress messages
    if (isStreamingMessage) {
      // FIXED: Allow special characters in streaming messages by only filtering control chars
      const cleanedMessage = message.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
      formattedMessage = `<div class="message-line streaming-message">[${timestamp}] ${cleanedMessage}<span class="terminal-cursor">_</span></div>`;
    } 
    // Handle timeout messages with special formatting
    else if (message.includes("(timeout)")) {
      // Highlight timeout messages differently
      formattedMessage = `<div class="message-line timeout-message">[${timestamp}] ${message}</div>`;
    }
    // Standard message format
    else {
      formattedMessage = `<div class="message-line">[${timestamp}] ${message}</div>`;
    }
    
    // Log the HTML being inserted
    console.log('Inserting formatted message:', formattedMessage);
    
    // Direct DOM update - much more reliable than React state for this case
    if (messageDisplayRef.current) {
      console.log('messageDisplayRef is valid, updating DOM');
      
      // Handle streaming updates differently
      if (isStreamingMessage) {
        // If there's an existing streaming message, update it instead of adding a new one
        const existingStreamingMessage = messageDisplayRef.current.querySelector('.streaming-message');
        if (existingStreamingMessage) {
          console.log('Updating existing streaming message');
          // Strip the wrapping div but preserve the newline
          existingStreamingMessage.innerHTML = formattedMessage.replace('<div class="message-line streaming-message">', '').replace('</div>', '');
          
          // Force DOM refresh by triggering a reflow
          const forceReflow = messageDisplayRef.current.offsetHeight;
          
          // Set scrollTop to 0 to ensure the newest messages are visible
          messageDisplayRef.current.scrollTop = 0;
          return; // Don't add a new message line
        }
      }
      
      // Clear placeholder text if this is the first message
      if (messageDisplayRef.current.innerText === 'No messages received yet.' || 
          messageDisplayRef.current.innerText === 'NO INCOMING TRANSMISSION DETECTED...\n_ ' ||
          messageDisplayRef.current.innerHTML.trim() === '') {
        console.log('Clearing placeholder text');
        messageDisplayRef.current.innerHTML = formattedMessage;
      } else {
        // Add the new message to the top
        messageDisplayRef.current.innerHTML = formattedMessage + messageDisplayRef.current.innerHTML;
      }
      
      // Make clear button visible if it exists
      const clearButton = document.querySelector('.clear-button') as HTMLButtonElement;
      if (clearButton) clearButton.style.display = 'block';
      
      // Force DOM refresh by triggering a reflow
      const forceReflow = messageDisplayRef.current.offsetHeight;
      
      // Always scroll to top after adding a new message
      messageDisplayRef.current.scrollTop = 0;
    } else {
      console.warn('messageDisplayRef.current is null - cannot update DOM directly');
    }
    
    // Skip React state update for sent messages
    if (isSentMessage) {
      console.log('Skipping React state update for [SENT] message to prevent style overrides');
      return;
    }
    
    // For non-SENT messages, update React state as a backup 
    setReceivedMessage(prevMessage => {
      // Just use plain text for the React state without HTML tags
      // Add a definite newline between messages
      const newMessage = `[${timestamp}] ${message}\n\n${prevMessage || ''}`;
      // Force a UI refresh immediately
      setTimeout(() => setForceUpdate(prev => prev + 1), 10);
      return newMessage;
    });
    
    // Update ref tracking for the last received message
    lastReceivedTextRef.current = message;
  };
  
  // Generate mock frequency data for testing
  const generateMockFrequencyData = useCallback(() => {
    const baseValues = Array(140).fill(0).map((_, i) => {
      // Create a baseline pattern with some peaks
      const baseValue = 20 + Math.sin(i / 10) * 15;
      // Add some random variation
      return Math.max(0, baseValue + Math.random() * 30);
    });
    
    // Add a few prominent peaks to simulate active frequencies
    const numPeaks = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < numPeaks; i++) {
      const peakPos = Math.floor(Math.random() * baseValues.length);
      baseValues[peakPos] = 150 + Math.random() * 100;
      // Add some spread around the peak
      if (peakPos > 0) baseValues[peakPos - 1] = 100 + Math.random() * 50;
      if (peakPos < baseValues.length - 1) baseValues[peakPos + 1] = 100 + Math.random() * 50;
    }
    
    return baseValues;
  }, []);
  
  // Start analyzing frequencies with sound visualization
  const updateFrequencies = () => {
    // Use ref for checking listening state to avoid closure issues
    if (!isListeningRef.current) {
      return;
    }
    
    // Skip audio processing while transmitting to avoid conflicts
    if (isTransmitting || isActivelyTransmittingRef.current) {
      // Just update the visualizer and continue the animation frame
      if (useMockData) {
        const mockData = generateMockFrequencyData();
        setFrequencies(mockData);
      } else if (analyserRef.current && audioContextRef.current) {
        // If we have analyzer access, still update the visualizer with real data
        const bufferLength = analyserRef.current.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        // Get frequency data
        analyserRef.current.getByteFrequencyData(dataArray);
        
        // Calculate the frequency range to show
        const nyquistFrequency = audioContextRef.current.sampleRate / 2;
        const maxBinToShow = Math.ceil((MAXIMUM_VALID_FREQUENCY / nyquistFrequency) * (dataArray.length));
        const minBinToShow = 15; // Skip lowest frequencies
        
        // Get raw frequency data
        const fullFrequencyRange = Array.from(dataArray.slice(minBinToShow, maxBinToShow));
        
        // Apply the same enhancement to transmit mode visualization
        const enhancedFrequencies = [];
        for (let i = 0; i < fullFrequencyRange.length; i++) {
          const normalizedPosition = i / fullFrequencyRange.length;
          let value = fullFrequencyRange[i];
          
          // Boost mid-range frequencies
          if (normalizedPosition > 0.15 && normalizedPosition < 0.7) {
            value = Math.min(255, value * 1.3); // Boost mid-range by 30%
          }
          
          enhancedFrequencies.push(value);
        }
        
        setFrequencies(enhancedFrequencies);
      }
      
      // Continue the animation loop without attempting to decode audio
      animationFrameRef.current = requestAnimationFrame(updateFrequencies);
      return;
    }
    
    // If using mock data, generate it instead of reading from microphone
    if (useMockData) {
      const mockData = generateMockFrequencyData();
      setFrequencies(mockData);
      
      // Periodically "decode" a fake message
      if (Math.random() < 0.001) {
        const mockMessage = `Test message ${new Date().toLocaleTimeString()}`;
        setDebugText(`Decoded mock: "${mockMessage}"`);
        addReceivedMessage(mockMessage);
      }
      
      // Force UI update every 30 frames
      if (debugMsgCountRef.current % 30 === 0) {
        setForceUpdate(prev => prev + 1);
      }
      debugMsgCountRef.current++;
      
      // Continue the animation loop
      animationFrameRef.current = requestAnimationFrame(updateFrequencies);
      return;
    }
    
    // Normal audio processing - check for all requirements
    if (!analyserRef.current || !audioContextRef.current) {
      setDebugText('ERROR: Missing audio components. Try restarting listening.');
      return;
    }

    try {
      const bufferLength = analyserRef.current.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      // Get frequency data
      analyserRef.current.getByteFrequencyData(dataArray);

      // Calculate the maximum frequency value for debugging
      let maxValue = 0;
      let maxBin = 0;
      for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i] > maxValue) {
          maxValue = dataArray[i];
          maxBin = i;
        }
      }
      
      const dominantFreq = maxBin * audioContextRef.current.sampleRate / (dataArray.length * 2);
      
      // Update debug text more infrequently and without frequency details
      if (debugMode && debugMsgCountRef.current % 30 === 0) {
        setDebugText(`System active - audio processing`);
      }
      debugMsgCountRef.current++;

      // IMPROVED: Calculate frequency range to display fully up to MAXIMUM_VALID_FREQUENCY
      // Find the right slice of frequency bins to display up to our maximum frequency
      const nyquistFrequency = audioContextRef.current.sampleRate / 2; // Maximum representable frequency
      const maxValidFrequency = MAXIMUM_VALID_FREQUENCY; // From MAXIMUM_VALID_FREQUENCY in audioCodec.ts
      const maxBinToShow = Math.ceil((maxValidFrequency / nyquistFrequency) * (dataArray.length));
      
      // Skip very low frequencies (first 10-20 bins) that are often just noise
      const minBinToShow = 15; // Skip first 15 bins of very low frequencies to focus on useful range
      
      // Compress the high-frequency bins to emphasize the important mid-range frequencies
      // This makes the visualization more useful by focusing on the most relevant frequencies
      const compressedFrequencies = [];
      
      // Take raw data for lower frequencies (more important for our character detection)
      const fullFrequencyRange = Array.from(dataArray.slice(minBinToShow, maxBinToShow));
      
      // Apply a simple exponential scale transformation to emphasize midrange frequencies
      // This helps make the bars more visible and useful for the expanded frequency range
      for (let i = 0; i < fullFrequencyRange.length; i++) {
        const normalizedPosition = i / fullFrequencyRange.length;
        // Apply a non-linear scaling to emphasize middle frequencies
        let value = fullFrequencyRange[i];
        
        // Boost mid-range frequencies (where most characters are)
        if (normalizedPosition > 0.15 && normalizedPosition < 0.7) {
          value = Math.min(255, value * 1.3); // Boost mid-range by 30%
        }
        
        compressedFrequencies.push(value);
      }
      
      // Always update frequencies with our optimized data
      setFrequencies(compressedFrequencies);

      // Force update on UI regardless
      if (debugMsgCountRef.current % 30 === 0) {
        setForceUpdate(prev => prev + 1);
      }
      
      // CRITICAL CHECK: Do not attempt to decode audio if transmitting
      if (isTransmitting || isActivelyTransmittingRef.current) {
        // Skip all audio decoding when transmitting
        animationFrameRef.current = requestAnimationFrame(updateFrequencies);
        return;
      }
      
      // Only try to decode if we're not transmitting (redundant check for safety)
      if (!isTransmitting && !isActivelyTransmittingRef.current) {
        // Try to decode any message - make sure this call is working
        try {
          const decodedText = decodeAudio(dataArray, audioContextRef.current.sampleRate);
          
          // Handle decoded text if we got something back
          if (decodedText) {
            console.log("Decode audio returned:", decodedText);
            
            // Handle streaming start marker
            if (decodedText === "[STREAM_START]" && !isTransmitting && !isActivelyTransmittingRef.current) {
              console.log("Beginning streaming message...");
              setIsCurrentlyStreaming(true);
              currentStreamingText.current = '';
              
              // Update UI to show we're receiving - use comprehensive check
              const statusIndicator = document.querySelector('.status-indicator');
              if (statusIndicator && !isTransmitting && !isActivelyTransmittingRef.current) {
                // Add console logging to help debug the issue
                console.log("Setting status to RECEIVING TRANSMISSION");
                statusIndicator.textContent = "RECEIVING TRANSMISSION";
                statusIndicator.classList.add('streaming');
              }
              
              setDebugText("Receiving transmission...");
            }
            // Handle streaming content
            else if (decodedText && decodedText.startsWith("[STREAM]") && isCurrentlyStreaming && !isTransmitting && !isActivelyTransmittingRef.current) {
              const newChars = decodedText.substring(8);
              
              // MODIFIED: Accept all printable characters including special characters
              // Only filter out control characters and truly non-printable characters
              const filteredChars = newChars.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
              
              if (filteredChars.length > 0) {
                currentStreamingText.current += filteredChars;
                console.log("Streaming chars:", filteredChars, "Current buffer:", currentStreamingText.current);
                
                // Always update the UI immediately when we get characters
                addReceivedMessage("RECEIVING: " + currentStreamingText.current, true);
                setDebugText(`Streaming: ${currentStreamingText.current}`);
                
                // Force render update immediately
                setForceUpdate(prev => prev + 1);
              }
            }
            // Handle streaming end - may also contain the full validated message
            else if (decodedText.startsWith("[STREAM_END]") && !isTransmitting && !isActivelyTransmittingRef.current) {
              console.log("End of streaming message");
              setIsCurrentlyStreaming(false);
              
              // Reset the status indicator
              const statusIndicator = document.querySelector('.status-indicator');
              if (statusIndicator && !isTransmitting && !isActivelyTransmittingRef.current) {
                statusIndicator.textContent = "RECEIVING";
                statusIndicator.classList.remove('streaming');
              }
              
              // Handle timeout case specifically
              if (decodedText.includes("(timeout)")) {
                console.log("Transmission timed out");
                
                // Extract any partial message after "[STREAM_END] " and before " (timeout)"
                const timeoutIndex = decodedText.indexOf("(timeout)");
                let finalMessage = "TRANSMISSION TIMEOUT";
                
                // If we have content before the timeout message, extract it
                if (timeoutIndex > 12) { // "[STREAM_END] " is 12 chars
                  const partialContent = decodedText.substring(12, timeoutIndex).trim();
                  if (partialContent) {
                    // MODIFIED: Allow special characters in timeout messages
                    const sanitizedMessage = partialContent.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
                    if (sanitizedMessage) {
                      finalMessage = "RECEIVED (TIMEOUT): " + sanitizedMessage;
                      
                      // Try to make an educated guess about what was being sent
                      if (sanitizedMessage.includes("T") || 
                          sanitizedMessage.includes("E") || 
                          sanitizedMessage.includes("S")) {
                        console.log("Message appears to be a TEST message");
                        // Add a hint for the user in debug mode
                        if (debugMode) {
                          setDebugText(`Partial TEST message received: ${sanitizedMessage} - likely "TEST123"`);
                        }
                      }
                    }
                  }
                }
                addReceivedMessage(finalMessage);
                setDebugText(`Transmission timed out: ${finalMessage}`);
              }
              // Check if we have a validated message
              else if (decodedText.length > 12) { // "[STREAM_END] " is 12 chars
                const finalMessage = decodedText.substring(12);
                // MODIFIED: Allow special characters in received messages
                const sanitizedMessage = finalMessage.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
                addReceivedMessage(sanitizedMessage);
                setDebugText(`Decoded: "${sanitizedMessage}"`);
              } else {
                // No validated message, just end the streaming
                const finalStreamContent = currentStreamingText.current;
                // Only add a message if we have streamed content
                if (finalStreamContent) {
                  addReceivedMessage("RECEIVED: " + finalStreamContent);
                }
                setDebugText("Transmission ended");
              }
              currentStreamingText.current = '';
            }
            // Handle normal message (not a streaming one)
            else if (!decodedText.startsWith("[STREAM]") && decodedText.trim() !== '' && !isTransmitting && !isActivelyTransmittingRef.current) {
              // MODIFIED: Allow special characters in normal messages
              const sanitizedMessage = decodedText.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
              if (sanitizedMessage.trim() !== '') {
                setDebugText(`Decoded: "${sanitizedMessage}"`);
                addReceivedMessage(sanitizedMessage);
              }
            }
          }
        } catch (decodeError) {
          console.error('Error in decodeAudio:', decodeError);
        }
      }
    } catch (error) {
      console.error('Error in updateFrequencies:', error);
      setDebugText(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // Continue the animation loop
    animationFrameRef.current = requestAnimationFrame(updateFrequencies);
  };
  
  // Function to play a test tone to verify audio is working
  const playTestTone = useCallback(async () => {
    if (!audioContextRef.current) return;
    
    const oscillator = audioContextRef.current.createOscillator();
    const gainNode = audioContextRef.current.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 440; // A4 note
    
    gainNode.gain.value = 0.1; // Quiet tone
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContextRef.current.destination);
    
    oscillator.start();
    setTimeout(() => oscillator.stop(), 200); // Stop after 200ms
    
    setDebugText('Playing test tone (440Hz)');
  }, []);
  
  // Start listening to microphone
  const startListening = async () => {
    try {
      setDebugText('Initializing microphone...');
      
      // Get a ready-to-use audio context
      const audioContext = await getAudioContext();
      
      if (!audioContext || !analyserRef.current) {
        const errorMsg = 'Failed to initialize AudioContext';
        console.error(errorMsg);
        setDebugText(errorMsg);
        return;
      }
      
      // If we're using mock data, skip microphone access
      if (useMockData) {
        setDebugText('MOCK MODE: Using simulated frequency data');
        setIsListening(true);
        
        // Play a test tone to verify audio is working
        await playTestTone();
        
        // Start the animation loop with mock data
        animationFrameRef.current = requestAnimationFrame(updateFrequencies);
        return;
      }
      
      // Ensure we use the correct constraints for maximum compatibility
      try {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ 
          audio: { 
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          } 
        });
        
        // IMPORTANT: Verify we're getting audio data
        const audioTracks = streamRef.current.getAudioTracks();
        
        setDebugText(`Microphone connected: ${audioTracks[0]?.label || 'Unknown'}`);
        
        // Play a test tone to verify audio output is working
        await playTestTone();
        
        // Create a new source from the stream
        const source = audioContext.createMediaStreamSource(streamRef.current);
        
        // Disconnect any existing connections
        if (analyserRef.current) {
          try {
            analyserRef.current.disconnect();
          } catch (e) {
            // Ignore disconnect errors
          }
        }
        
        // Configure the analyzer for better performance
        analyserRef.current.fftSize = 2048;  // Higher FFT for better resolution
        analyserRef.current.smoothingTimeConstant = 0.3;  // Less smoothing for better responsiveness
        
        // Connect the source to the analyzer
        source.connect(analyserRef.current);
        
        setIsListening(true);
        
        // Cancel any existing animation frame
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        
        // Start the visualization loop - log when we start
        animationFrameRef.current = requestAnimationFrame(updateFrequencies);
      } catch (micError) {
        console.error('Failed to access microphone:', micError);
        setDebugText(`Microphone error: ${micError instanceof Error ? micError.message : 'Unknown error'}. Switching to mock data.`);
        
        // Switch to mock data mode when microphone fails
        setUseMockData(true);
        setIsListening(true);
        
        // Start the animation loop with mock data
        animationFrameRef.current = requestAnimationFrame(updateFrequencies);
      }
      
    } catch (error) {
      console.error('Error in startListening:', error);
      setDebugText(`Error: ${error instanceof Error ? error.message : 'Unknown error'}. Try using mock data.`);
    }
  };
  
  const stopListening = () => {
    setDebugText('Stopping...');
    
    // Cancel the animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    setIsListening(false);
    setFrequencies([]); // Clear the frequency display
  };
  
  // Enable compatibility mode which sends and receives a test message automatically
  useEffect(() => {
    // Only send test messages if sendTestMessages is enabled
    if (compatibilityMode && sendTestMessages && isListening && !isTransmitting) {
      // Wait 1 second after listening starts before sending test message
      const sendTestMessage = setTimeout(async () => {
        if (!isListeningRef.current) return;
        
        try {
          console.log('Compatibility mode: sending test message');
          setDebugText('Compatibility mode: sending test message');
          
          // Get audio context ready
          const audioContext = await getAudioContext();
          if (!audioContext) return;
          
          // Send a very simple message
          const testMsg = "TEST " + Math.floor(Math.random() * 1000);
          await encodeText(testMsg, audioContext);
          
          // Add it directly to the messages with a prefix
          setTimeout(() => {
            addReceivedMessage(`[SELF-TEST]: ${testMsg}`);
            setDebugText('Test message sent and displayed');
          }, 500);
        } catch (err) {
          console.error('Error in compatibility mode test:', err);
        }
      }, 1000);
      
      return () => clearTimeout(sendTestMessage);
    }
  }, [compatibilityMode, sendTestMessages, isListening, isTransmitting]);
  
  const transmitMessage = async () => {
    if (!inputText || isTransmitting) return;
    
    // Set both the state and the ref
    setIsTransmitting(true);
    isActivelyTransmittingRef.current = true;
    
    // Add logging to trace transmission state changes
    console.log('TRANSMISSION STARTED - Blocking all receiving modes');
    
    setDebugText(`Transmitting: "${inputText}"`);
    console.log('Transmitting:', inputText);
    
    // Instead of pausing receiving, change visualization to green mode
    setTransmitVisualization(true);
    let wasListening = false;
    
    // We no longer cancel the animation frame, just track if we were listening
    if (animationFrameRef.current) {
      console.log('Switching to transmission visualization mode');
      wasListening = true;
      // Don't cancel the animation frame, keep visualization running with green colors
    }
    
    // Update status indicator to show "TRANSMITTING" only
    const statusIndicator = document.querySelector('.status-indicator');
    if (statusIndicator) {
      statusIndicator.textContent = "TRANSMITTING";
      statusIndicator.classList.add('transmitting');
      statusIndicator.classList.remove('streaming'); // Make sure streaming class is removed
    }
    
    try {
      // Record start time for statistics
      transmissionStartTime.current = performance.now();
      
      // Get a ready-to-use audio context
      const audioContext = await getAudioContext();
      
      if (!audioContext) {
        console.error('Failed to get AudioContext for transmission');
        setDebugText('Failed to initialize audio for transmission');
        return;
      }
      
      // Play the audio sequence with the new hexadecimal encoding
      await encodeText(inputText, audioContext);
      
      // Calculate and display transmission statistics
      const endTime = performance.now();
      const duration = (endTime - transmissionStartTime.current) / 1000; // in seconds
      const charCount = inputText.length;
      const charsPerSecond = charCount / duration;
      
      setTxStats({
        charCount,
        duration,
        charsPerSecond
      });
      
      setDebugText(`Transmission complete: ${charCount} chars in ${duration.toFixed(2)}s`);
      console.log(`Transmission complete: ${charCount} chars at ${charsPerSecond.toFixed(2)} chars/s`);
      
      // UPDATED: Add sent message directly to the sent messages container
      setTimeout(() => {
        // Create our sent message in standard format
        const sentMessage = `[SENT] ${inputText}`;
        
        // Use our improved function to add it directly to the separate container
        addReceivedMessage(sentMessage);
        
        console.log('Added message with [SENT] prefix to separate container:', sentMessage);
      }, 300);
      
      // Clear the input after successful transmission
      setInputText('');
    } catch (error) {
      console.error('Error transmitting message:', error);
      setDebugText(`Transmission error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Set both the state and the ref
      setIsTransmitting(false);
      isActivelyTransmittingRef.current = false;
      
      // Add logging to trace transmission state changes
      console.log('TRANSMISSION ENDED - Allowing receiving modes again');
      
      // Turn off green visualization mode
      setTransmitVisualization(false);
      
      // Reset status indicator after transmission is complete
      const statusIndicator = document.querySelector('.status-indicator');
      if (statusIndicator) {
        statusIndicator.textContent = "STANDBY";
        statusIndicator.classList.remove('transmitting');
      }
      
      // We don't need to resume the animation frame since we kept it running
      // Just log that we're back to normal mode
      if (wasListening && isListeningRef.current) {
        console.log('Returning to normal visualization mode after transmission');
      }
    }
  };

  // Function to initialize audio context on user interaction
  const handleUserInteraction = async () => {
    try {
      await getAudioContext();
      setDebugText('Audio initialized (click Start Listening to begin)');
      
      // Show initial "RECEIVING DATA..." message only if it hasn't been shown already
      if (!initialMessageShown && messageDisplayRef.current) {
        addReceivedMessage("RECEIVING DATA...", true);
        setInitialMessageShown(true);
      }
    } catch (error) {
      console.error('Error initializing AudioContext:', error);
      setDebugText(`Audio init error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
  
  // Function to clear received messages with direct DOM access
  const clearMessages = () => {
    // Update React state
    setReceivedMessage('');
    receivedMessagesRef.current.clear();
    
    // Direct DOM update
    if (messageDisplayRef.current) {
      messageDisplayRef.current.innerHTML = ''; // Use empty string to trigger the :empty pseudo-selector
    }
    
    // Also clear sent messages container
    if (sentMessagesContainerRef.current) {
      sentMessagesContainerRef.current.innerHTML = '';
    }
    
    // Hide the clear button
    const clearButton = document.querySelector('.clear-button') as HTMLButtonElement;
    if (clearButton) clearButton.style.display = 'none';
    
    setDebugText('Messages cleared');
  };
  
  // Toggle debug mode
  const toggleDebugMode = () => {
    setDebugMode(!debugMode);
  };
  
  // Auto-start listening when the component mounts
  useEffect(() => {
    // Auto initialize the system with a small delay
    const initTimeout = setTimeout(() => {
      handleUserInteraction().then(() => {
        setSystemInitialized(true);
        // Auto-start listening with a short delay after initialization
        setTimeout(() => {
          startListening();
        }, 500);
      });
    }, 1000);
    
    return () => clearTimeout(initTimeout);
  }, []);
  
  // Ensure messageDisplayRef is correctly initialized in useEffect
  useEffect(() => {
    // Log when the ref is connected to ensure it's properly set up
    if (messageDisplayRef.current) {
      console.log('Message display ref initialized correctly');
    } else {
      console.warn('Message display ref is not connected to DOM element');
    }
  }, []);
  
  // Add useEffect to set the favicon when component mounts
  useEffect(() => {
    // Create or select the favicon link element
    let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    
    // Set the href to our audio wave SVG
    link.href = AUDIO_FAVICON;
    
    // Also set apple-touch-icon for iOS devices
    let appleLink = document.querySelector("link[rel~='apple-touch-icon']") as HTMLLinkElement;
    if (!appleLink) {
      appleLink = document.createElement('link');
      appleLink.rel = 'apple-touch-icon';
      document.head.appendChild(appleLink);
    }
    appleLink.href = AUDIO_FAVICON;
    
    console.log('Audio favicon set');
  }, []);
  
  // Add a specific useEffect to inject a style element that will override all other rules
  useEffect(() => {
    // Create a style element with the highest priority CSS rules
    const styleElement = document.createElement('style');
    styleElement.setAttribute('id', 'sent-message-override-styles');
    styleElement.textContent = `
      /* Direct override for any text matching the [SENT] pattern */
      div:has-text("[SENT]"),
      div:contains("[SENT]"),
      div[data-sent="true"],
      div.sent-message,
      .message-line:has-text("[SENT]") {
        color: #00ff41 !important;
        font-weight: bold !important;
        text-shadow: 0 0 5px rgba(0, 255, 65, 0.3) !important;
        border-left: 4px solid #00ff41 !important;
        background-color: rgba(0, 20, 0, 0.4) !important;
      }
      
      /* Force all child elements to have the same color */
      div:has-text("[SENT]") *,
      div:contains("[SENT]") *,
      div[data-sent="true"] *,
      div.sent-message *,
      .message-line:has-text("[SENT]") * {
        color: #00ff41 !important;
      }
      
      /* Target exact pattern format with timestamp */
      div:has-text(/\\[\\d{2}:\\d{2}:\\d{2}\\] \\[SENT\\]/),
      div:contains(/\\[\\d{2}:\\d{2}:\\d{2}\\] \\[SENT\\]/) {
        color: #00ff41 !important;
      }
    `;
    document.head.appendChild(styleElement);
    
    // Set up a MutationObserver to watch for DOM changes and apply styling to new [SENT] messages
    const handleMutation = (mutations: MutationRecord[]) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node: Node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if this element or any of its children contains [SENT]
              if ((node as Element).textContent?.includes('[SENT]')) {
                const element = node as HTMLElement;
                if (element) {
                  element.style.color = '#00ff41';
                  element.style.fontWeight = 'bold';
                  element.style.textShadow = '0 0 5px rgba(0, 255, 65, 0.3)';
                  element.style.borderLeft = '4px solid #00ff41';
                  element.style.backgroundColor = 'rgba(0, 20, 0, 0.4)';
                  element.classList.add('sent-message');
                }
                
                // Apply to all child nodes
                (node as Element).querySelectorAll('*').forEach((child: Element) => {
                  const childElement = child as HTMLElement;
                  if (childElement) {
                    childElement.style.color = '#00ff41';
                  }
                });
              }
            }
          });
        }
      }
    };
    
    // Create and start the observer if we have a valid message display ref
    if (messageDisplayRef.current) {
      const observer = new MutationObserver(handleMutation);
      observer.observe(messageDisplayRef.current, { 
        childList: true, 
        subtree: true,
        characterData: true,
        attributes: true
      });
      
      // Make sure to clean up
      return () => {
        observer.disconnect();
        if (styleElement.parentNode) {
          styleElement.parentNode.removeChild(styleElement);
        }
      };
    }
  }, []);
  
  useEffect(() => {
    // Create a style element for direct styling
    const styleElement = document.createElement('style');
    styleElement.innerHTML = `
      /* Direct node targeting styles */
      .sent-message-direct {
        color: #00ff41 !important;
        font-weight: bold !important;
        text-shadow: 0 0 5px rgba(0, 255, 65, 0.3) !important;
        border-left: 4px solid #00ff41 !important;
        background-color: rgba(0, 20, 0, 0.4) !important;
        padding-left: 8px !important;
      }
    `;
    document.head.appendChild(styleElement);

    // Function to process nodes
    function processSentMessages() {
      // Get the message display element
      const messageDisplay = document.querySelector('[data-testid="message-display"]') || 
                             document.querySelector('.received-message');
      
      if (!messageDisplay) return;
      
      // Get all text nodes in the message display
      const textNodes: Text[] = [];
      const walk = document.createTreeWalker(
        messageDisplay, 
        NodeFilter.SHOW_TEXT
      );
      
      let node: Node | null;
      while (node = walk.nextNode()) {
        textNodes.push(node as Text);
      }
      
      // Process each text node
      textNodes.forEach(textNode => {
        if (textNode.textContent && textNode.textContent.includes("[SENT]")) {
          // Get the parent element of the text node
          const element = textNode.parentElement;
          
          // If it's null or already styled, skip it
          if (!element || element.classList.contains('sent-message-direct')) return;
          
          // Apply styling directly
          element.classList.add('sent-message-direct');
          
          // Also apply to all child elements
          const children = element.querySelectorAll('*');
          children.forEach(child => {
            if (child instanceof HTMLElement) {
              child.classList.add('sent-message-direct');
              child.style.color = '#00ff41';
            }
          });
        }
      });
    }

    // Set up MutationObserver to watch for changes
    const observer = new MutationObserver(() => {
      processSentMessages();
    });

    // Start observing
    const messageDisplay = document.querySelector('[data-testid="message-display"]') || 
                           document.querySelector('.received-message');
    
    if (messageDisplay) {
      observer.observe(messageDisplay, { 
        childList: true, 
        subtree: true,
        characterData: true 
      });
      
      // Process existing messages
      processSentMessages();
    }

    return () => {
      observer.disconnect();
      document.head.removeChild(styleElement);
    };
  }, []);
  
  // Add a new useEffect to ensure [SENT] messages stay colored by manually re-applying styles
  useEffect(() => {
    // Function to ensure all sent messages are green
    const maintainSentMessageStyles = () => {
      // First look for messages with the data-permanent-sent attribute
      if (messageDisplayRef.current) {
        const sentMessages = messageDisplayRef.current.querySelectorAll('[data-permanent-sent="true"]');
        sentMessages.forEach(element => {
          if (element instanceof HTMLElement) {
            // Re-apply all the necessary styles
            element.style.color = '#00ff41';
            element.style.fontWeight = 'bold';
            element.style.textShadow = '0 0 5px rgba(0, 255, 65, 0.3)';
            element.style.borderLeft = '4px solid #00ff41';
            element.style.backgroundColor = 'rgba(0, 20, 0, 0.4)';
            
            // Apply styles to all child elements
            const children = element.querySelectorAll('*');
            children.forEach(child => {
              if (child instanceof HTMLElement) {
                child.style.color = '#00ff41';
              }
            });
          }
        });
        
        // Next, look for any content with [SENT] text
        const allMessageLines = messageDisplayRef.current.querySelectorAll('.message-line');
        allMessageLines.forEach(line => {
          if (line.textContent && line.textContent.includes('[SENT]')) {
            if (line instanceof HTMLElement) {
              // Apply styles to this element if it contains [SENT]
              line.style.color = '#00ff41';
              line.style.fontWeight = 'bold';
              line.style.textShadow = '0 0 5px rgba(0, 255, 65, 0.3)';
              line.style.borderLeft = '4px solid #00ff41';
              line.style.backgroundColor = 'rgba(0, 20, 0, 0.4)';
              line.setAttribute('data-permanent-sent', 'true');
              
              // Apply styles to all child elements
              const children = line.querySelectorAll('*');
              children.forEach(child => {
                if (child instanceof HTMLElement) {
                  child.style.color = '#00ff41';
                }
              });
            }
          }
        });
      }
    };
    
    // Run immediately
    maintainSentMessageStyles();
    
    // Set up an interval to periodically check and maintain sent message styles
    const styleInterval = setInterval(maintainSentMessageStyles, 500);
    
    // Clean up the interval on unmount
    return () => clearInterval(styleInterval);
  }, []);
  
  return (
    <div className="app-container" onClick={handleUserInteraction}>
      <div className="title-container">
        <h1>CHIRP // AUDIO DATA TRANSMISSION</h1>
      </div>
      
      {/* Controls are still in the DOM but hidden with CSS */}
      <div className="controls">
        <button 
          onClick={isListening ? stopListening : startListening}
          className={isListening ? 'active' : ''}
        >
          {isListening ? 'Stop Listening' : 'Start Listening'}
        </button>
        <button 
          onClick={toggleDebugMode}
          className={debugMode ? 'debug active' : 'debug'}
        >
          {debugMode ? 'Hide Debug' : 'Show Debug'}
        </button>
        <button 
          onClick={() => addReceivedMessage("TEST MESSAGE " + new Date().toLocaleTimeString())}
          className="test-button"
        >
          Test Message
        </button>
        <button 
          onClick={() => {
            setUseMockData(!useMockData);
            setDebugText(`Mode: ${!useMockData ? 'Using mock data' : 'Using real microphone'}`);
          }}
          className={useMockData ? 'mock active' : 'mock'}
        >
          {useMockData ? 'Using Mock Data' : 'Use Mock Data'}
        </button>
        <button 
          onClick={() => {
            setSendTestMessages(!sendTestMessages);
            setDebugText(`Test Messages: ${!sendTestMessages ? 'ON' : 'OFF'}`);
          }}
          className={sendTestMessages ? 'compat active' : 'compat'}
        >
          {sendTestMessages ? 'Tests ON' : 'Send Tests'}
        </button>
      </div>
      
      {/* Debug container is hidden with CSS */}
      {debugMode && (
        <div className="debug-container" key={`debug-${forceUpdate}`}>
          <div className="debug-info">{debugText}</div>
          <div className="debug-info">Message state: {receivedMessage ? `"${receivedMessage}"` : "empty"}</div>
          <div className="debug-info">Frequencies: {frequencies.length > 0 ? `${frequencies.length} values, max=${Math.max(...frequencies)}` : "none"}</div>
          <div className="debug-info">AnimFrame: {animationFrameRef.current ? "active" : "none"}</div>
          <div className="debug-info">Modes: {[
            useMockData ? "MOCK DATA" : "REAL MIC",
            compatibilityMode ? "COMPAT MODE" : "NORMAL MODE",
            sendTestMessages ? "AUTO-TEST ON" : "AUTO-TEST OFF"
          ].join(', ')}</div>
          <div className="debug-info">
            <button onClick={playTestTone} className="small-button">Play Test Tone</button>
            <button 
              onClick={() => {
                // Force a test message to appear in output with explicit format
                const testMsg = `FORCED TEST (${new Date().toLocaleTimeString()})`;
                console.log('Adding test message:', testMsg);
                addReceivedMessage(testMsg);
                setDebugText('Force-added a test message with timestamp');
              }} 
              className="small-button"
            >
              Force Message
            </button>
            <button 
              onClick={() => {
                setCompatibilityMode(!compatibilityMode);
                setDebugText(`Compatibility Mode: ${!compatibilityMode ? 'ON' : 'OFF'}`);
              }} 
              className={`small-button ${compatibilityMode ? 'active' : ''}`}
            >
              {compatibilityMode ? 'Compat ON' : 'Compat OFF'}
            </button>
          </div>
        </div>
      )}
      
      <div className="visualizer-container">
        <div className="section-title">&gt; FREQUENCY ANALYSIS</div>
        <FrequencyVisualizer 
          frequencies={frequencies} 
          key={`viz-${forceUpdate % 10}`}
          transmitMode={transmitVisualization} // Pass prop to indicate transmission visualization
        />
        {!isListening && !systemInitialized && (
          <div className="status-indicator">SYSTEM INITIALIZING<span className="terminal-cursor">_</span></div>
        )}
        {txStats && (
          <div className="floating-stats-container">
            <div className="stats-label">TRANSMISSION DATA</div>
            <div className="stats-value">CHARS: {txStats.charCount}</div>
            <div className="stats-value">TIME: {txStats.duration.toFixed(2)}s</div>
            <div className="stats-value">SPEED: {txStats.charsPerSecond.toFixed(1)} c/s</div>
          </div>
        )}
        {debugMode && (
          <div className="frequency-range-info">
            RANGE: 0-{MAXIMUM_VALID_FREQUENCY}Hz | START: 2500Hz | END: 2700Hz | SPACE: 900Hz | SPECIAL: 1300-4600Hz | NUMBERS: 4700-5600Hz | UPPERCASE: 5700-8200Hz
          </div>
        )}
      </div>
      
      <div className="message-transmit-wrapper">
        <div className="message-container">
          <div className="section-title">&gt; INCOMING TRANSMISSION</div>
          <div 
            className="received-message" 
            key={`msg-${forceUpdate}`}
            ref={messageDisplayRef}
            data-testid="message-display" // Add test ID for easy DOM selection
          >
            {receivedMessage || 'NO INCOMING TRANSMISSION DETECTED...\n_ '}
          </div>
          
          {/* Add a completely separate container for sent messages that won't be affected by React updates */}
          <div 
            className="sent-messages-container"
            ref={sentMessagesContainerRef}
            data-testid="sent-messages-container"
            style={{ marginTop: '10px' }}
          >
            {/* Sent messages will be added here directly via DOM operations */}
          </div>
          
          {isListening && <div className="status-indicator">STANDBY<span className="terminal-cursor">_</span></div>}
        </div>
        
        <div className="transmit-container">
          <div className="section-title">&gt; TRANSMIT</div>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && inputText.trim() && !isTransmitting) {
                e.preventDefault();
                transmitMessage();
              }
            }}
            placeholder="ENTER MESSAGE FOR TRANSMISSION..."
            disabled={isTransmitting}
          />
          <button 
            onClick={transmitMessage}
            disabled={isTransmitting || !inputText}
          >
            {isTransmitting ? 'TRANSMITTING...' : 'TRANSMIT'}
          </button>
        </div>
      </div>
      
      {/* Attribution footer */}
      <div className="app-footer">
        Built by <a href="https://x.com/icesolst" target="_blank" rel="noopener noreferrer">solst/ICE</a> [<a href="https://github.com/solst-ice/chirp" target="_blank" rel="noopener noreferrer">code</a>]
      </div>
    </div>
  );
}

// Export the App component as default
export default App; 