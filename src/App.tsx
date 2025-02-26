import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import FrequencyVisualizer from './components/FrequencyVisualizer';
import { encodeText, decodeAudio, resetDecoder } from './utils/audioCodec';

// Add a console log to confirm the component is loading
console.log('Chirp system initializing');

function App() {
  const [inputText, setInputText] = useState('');
  const [receivedMessage, setReceivedMessage] = useState('');
  const [isListening, setIsListening] = useState(true);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [frequencies, setFrequencies] = useState<number[]>([]);
  const [debugText, setDebugText] = useState<string>('Initializing system...');
  const [debugMode, setDebugMode] = useState<boolean>(false);
  const [txStats, setTxStats] = useState<{
    charCount: number;
    duration: number;
    charsPerSecond: number;
  } | null>(null);
  
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
  
  // Function to directly update UI with a received message
  const addReceivedMessage = (message: string) => {
    // Only log actual messages, not empty ones
    if (message.trim()) {
      console.log('Message received for display:', message);
    }
    
    // Create timestamp with current time
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    // Log timestamp for debugging
    console.log(`Adding timestamp [${timestamp}] to message`);
    
    // Always create a consistent format with visible timestamp
    let formattedMessage = '';
    
    // Handle sent messages with special formatting
    if (message.startsWith('[SENT]') || message.startsWith('[SENT]:')) {
      // Clean up sent message format
      const cleanMessage = message.replace('[SENT]:', '[SENT]').trim();
      formattedMessage = `<div class="message-line"><span class="timestamp">[${timestamp}]</span> ${cleanMessage}</div>`;
    } else {
      // Standard message format
      formattedMessage = `<div class="message-line"><span class="timestamp">[${timestamp}]</span> ${message}</div>`;
    }
    
    // Log the HTML being inserted
    console.log('Inserting formatted message:', formattedMessage);
    
    // Direct DOM update - much more reliable than React state for this case
    if (messageDisplayRef.current) {
      // Clear placeholder text if this is the first message
      if (messageDisplayRef.current.innerText === 'No messages received yet.' || 
          messageDisplayRef.current.innerText === 'NO INCOMING TRANSMISSION DETECTED...\n_ ') {
        messageDisplayRef.current.innerHTML = formattedMessage;
      } else {
        // Add new message at the top
        messageDisplayRef.current.innerHTML = formattedMessage + messageDisplayRef.current.innerHTML;
      }
      
      // Make clear button visible
      const clearButton = document.querySelector('.clear-button') as HTMLButtonElement;
      if (clearButton) clearButton.style.display = 'block';
    } else {
      console.warn('messageDisplayRef.current is null - cannot update DOM directly');
    }
    
    // Update React state as a backup
    setReceivedMessage(prevMessage => {
      const newMessage = `[${timestamp}] ${message}\n${prevMessage || ''}`;
      // Force a UI refresh
      setTimeout(() => setForceUpdate(prev => prev + 1), 50);
      return newMessage;
    });
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

      // IMPROVED: Directly extract useful frequency range and normalize
      // Take a more focused range that's likely to contain our data
      const usefulDataRange = Array.from(dataArray.slice(10, 150)); 
      
      // Always update frequencies - performance is fine with modern browsers
      setFrequencies(usefulDataRange);
      
      // Force update on UI regardless
      if (debugMsgCountRef.current % 30 === 0) {
        setForceUpdate(prev => prev + 1);
      }
      
      // Try to decode any message - make sure this call is working
      try {
        const decodedText = decodeAudio(dataArray, audioContextRef.current.sampleRate);
        
        // Only add new text if it's not null
        if (decodedText && decodedText.trim() !== '') {
          setDebugText(`Decoded: "${decodedText}"`);
          
          // DIRECT ADD: Immediately add to messages
          addReceivedMessage(decodedText);
        }
      } catch (decodeError) {
        console.error('Error in decodeAudio:', decodeError);
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
    
    setIsTransmitting(true);
    setDebugText(`Transmitting: "${inputText}"`);
    console.log('Transmitting:', inputText);
    
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
      
      // IMPORTANT: Always add a consistent format for sent messages
      // This needs to be inside the timeout to allow for processing
      setTimeout(() => {
        // Force exact format - don't vary between tests
        addReceivedMessage(`[SENT] ${inputText}`);
      }, 300);
      
      // Clear the input after successful transmission
      setInputText('');
    } catch (error) {
      console.error('Error transmitting message:', error);
      setDebugText(`Transmission error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsTransmitting(false);
    }
  };

  // Function to initialize audio context on user interaction
  const handleUserInteraction = async () => {
    try {
      await getAudioContext();
      setDebugText('Audio initialized (click Start Listening to begin)');
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
      
      // Hide the clear button
      const clearButton = document.querySelector('.clear-button') as HTMLButtonElement;
      if (clearButton) clearButton.style.display = 'none';
    }
    
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
      </div>
      
      <div className="message-transmit-wrapper">
        <div className="message-container">
          <div className="section-title">&gt; INCOMING TRANSMISSION</div>
          <div 
            className="received-message" 
            key={`msg-${forceUpdate}`}
            ref={messageDisplayRef}
          >
            {receivedMessage || 'NO INCOMING TRANSMISSION DETECTED...\n_ '}
          </div>
          {isListening && <div className="status-indicator">RECEIVING<span className="terminal-cursor">_</span></div>}
        </div>
        
        <div className="transmit-container">
          <div className="section-title">&gt; TRANSMIT</div>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
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