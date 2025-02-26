import React, { useRef, useEffect } from 'react';

interface FrequencyVisualizerProps {
  frequencies: number[];
}

// Remove component load log
const FrequencyVisualizer: React.FC<FrequencyVisualizerProps> = ({ frequencies }) => {
  // Use a ref to check if we've mounted
  const mountedRef = useRef(false);
  const maxValueRef = useRef(0);
  const emptyFramesCountRef = useRef(0);
  
  // Reset max value periodically to adapt to changing volume
  useEffect(() => {
    mountedRef.current = true;
    
    // Reset max value every 5 seconds to adapt to changing volume
    const resetInterval = setInterval(() => {
      maxValueRef.current = Math.max(maxValueRef.current * 0.5, 30); // Fade the max value over time but keep a minimum
    }, 2000);
    
    return () => {
      mountedRef.current = false;
      clearInterval(resetInterval);
    };
  }, []);
  
  // Remove all logging from this effect
  useEffect(() => {
    if (mountedRef.current) {
      if (frequencies.length === 0) {
        // Count empty frames but don't log
        emptyFramesCountRef.current++;
      } else {
        // Reset empty frames counter but don't log
        emptyFramesCountRef.current = 0;
      }
    }
  }, [frequencies]);
  
  // If no frequencies, show placeholder with more information
  if (!frequencies.length) {
    return (
      <div className="frequency-visualizer empty">
        <span className="placeholder">
          {emptyFramesCountRef.current > 120 
            ? 'No audio data detected - check microphone permissions'
            : 'Waiting for frequency data...'}
        </span>
      </div>
    );
  }
  
  // If all zero, provide different message
  if (frequencies.every(f => f === 0)) {
    return (
      <div className="frequency-visualizer empty">
        <span className="placeholder">Audio connected but no sound detected</span>
      </div>
    );
  }
  
  // Find max value for scaling (with minimum threshold)
  const currentMax = Math.max(...frequencies);
  if (currentMax > maxValueRef.current) {
    maxValueRef.current = currentMax;
  }
  
  // Ensure we have a reasonable max value for scaling (with minimum to prevent division by zero)
  const maxValue = Math.max(maxValueRef.current, 30);
  
  // Calculate threshold for "active" bars (high energy frequencies)
  const activeThreshold = maxValue * 0.6;
  
  // Generate placeholder bars if needed (should never happen now)
  const displayFrequencies = frequencies.length > 10 ? frequencies : Array(50).fill(0).map(() => Math.random() * 20);
  
  return (
    <div className="frequency-visualizer">
      {displayFrequencies.map((value, index) => {
        // Scale height based on value (0-100% of container) with a minimum height
        const height = `${Math.max((value / maxValue) * 100, 2)}%`;
        const isActive = value > activeThreshold;
        
        return (
          <div
            key={index}
            className={`frequency-bar ${isActive ? 'active' : ''}`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
};

export default FrequencyVisualizer; 