import React, { useRef, useEffect } from 'react';
import './FrequencyVisualizer.css';
import { MAXIMUM_VALID_FREQUENCY } from '../utils/audioCodec';

interface FrequencyVisualizerProps {
  frequencies: number[];
  transmitMode?: boolean;
}

const FrequencyVisualizer: React.FC<FrequencyVisualizerProps> = ({ 
  frequencies,
  transmitMode = false
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Clear the canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Set background color
    ctx.fillStyle = '#000'; // Black background
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw vertical lines for separation
    ctx.strokeStyle = transmitMode ? 'rgba(0, 100, 0, 0.3)' : 'rgba(50, 50, 50, 0.5)';
    ctx.lineWidth = 1;
    
    const numDivisions = 10;
    const divisionWidth = canvas.width / numDivisions;
    
    // Draw frequency scale (Hz) at the bottom
    const maxFreq = MAXIMUM_VALID_FREQUENCY; // Use imported constant
    ctx.fillStyle = transmitMode ? 'rgba(0, 180, 40, 0.8)' : 'rgba(49, 133, 255, 0.8)';
    ctx.font = '10px monospace';
    
    // Add padding to ensure edge labels don't get cut off
    const edgePadding = 30; // Pixels to pad on each side
    const usableWidth = canvas.width - (edgePadding * 2);
    
    for (let i = 0; i <= numDivisions; i++) {
      // Calculate positions with padding
      const normalizedPosition = i / numDivisions;
      const x = edgePadding + (normalizedPosition * usableWidth);
      
      // Calculate the frequency at this position
      const freq = Math.round(normalizedPosition * maxFreq);
      
      // Set text alignment based on position
      if (i === 0) {
        ctx.textAlign = 'left'; // Left-align the first label
      } else if (i === numDivisions) {
        ctx.textAlign = 'right'; // Right-align the last label
      } else {
        ctx.textAlign = 'center'; // Center-align all other labels
      }
      
      // Draw frequency label
      ctx.fillText(`${freq}Hz`, x, canvas.height - 5);
      
      // Skip drawing the line at position 0
      if (i === 0) continue;
      
      // Draw division line (keeping original grid divisions)
      const gridX = i * (canvas.width / numDivisions);
      ctx.beginPath();
      ctx.moveTo(gridX, 0);
      ctx.lineTo(gridX, canvas.height - 15); // Make space for the labels
      ctx.stroke();
    }
    
    // Only draw if we have data
    if (!frequencies.length) return;
    
    // Adjust the drawing area for the frequency bars to account for padding
    const graphWidth = canvas.width - (2 * edgePadding);
    const barWidth = graphWidth / frequencies.length;
    
    // Draw each frequency bar
    frequencies.forEach((value, i) => {
      const x = edgePadding + (i * barWidth);
      
      // Normalize value to fit in canvas (values typically 0-255)
      // Increase minimum height to make small values more visible
      const normalizedHeight = (value / 255) * (canvas.height - 20); 
      const height = Math.max(3, normalizedHeight); // Increased minimum height from 1px to 3px
      const y = canvas.height - 20 - height;
      
      // Create a gradient for the bar color - use brighter colors for better visibility
      let gradient;
      if (transmitMode) {
        // Brighter green gradient for transmission mode
        gradient = ctx.createLinearGradient(0, y, 0, canvas.height - 20);
        gradient.addColorStop(0, 'rgba(0, 255, 120, 1.0)'); // Increased brightness and opacity
        gradient.addColorStop(1, 'rgba(0, 220, 80, 0.9)');  // Increased brightness and opacity
      } else {
        // Brighter cyan/blue gradient
        gradient = ctx.createLinearGradient(0, y, 0, canvas.height - 20);
        gradient.addColorStop(0, 'rgba(20, 255, 255, 1.0)'); // Increased brightness and opacity
        gradient.addColorStop(1, 'rgba(65, 155, 255, 0.9)'); // Increased brightness and opacity
      }
      
      ctx.fillStyle = gradient;
      
      // Draw a bar with increased width and slight glow effect
      const barWidthAdjusted = Math.max(2, barWidth - 1); // Ensure minimum width of 2px
      
      ctx.beginPath();
      ctx.moveTo(x, y); // Top left
      ctx.lineTo(x + barWidthAdjusted, y); // Top right
      ctx.lineTo(x + barWidthAdjusted, canvas.height - 20); // Bottom right
      ctx.lineTo(x, canvas.height - 20); // Bottom left
      ctx.closePath();
      ctx.fill();
      
      // Add glow effect to make bars more visible
      if (value > 50) { // Only add glow to significant signals
        ctx.shadowColor = transmitMode ? 'rgba(0, 255, 120, 0.7)' : 'rgba(20, 255, 255, 0.7)';
        ctx.shadowBlur = 3;
        ctx.fillRect(x, y, barWidthAdjusted, height);
        ctx.shadowBlur = 0; // Reset shadow for other elements
      }
    });
    
    // Draw key frequency markers for important ranges
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.textAlign = 'center';
    ctx.font = '9px monospace';
    
    // Draw markers for important ranges from our audio codec
    const keyRanges = [
      { freq: 900, label: 'SPACE' },
      { freq: 1300, label: 'SPECIAL' },
      { freq: 4700, label: 'NUMBERS' },
      { freq: 5700, label: 'LETTERS' },
      { freq: 2500, label: 'START' },
      { freq: 2700, label: 'END' }
    ];
    
    // Use the same padding logic for marker positions
    keyRanges.forEach(marker => {
      // Calculate normalized position (0-1) and apply padding
      const normalizedPos = marker.freq / maxFreq;
      const x = edgePadding + (normalizedPos * usableWidth);
      
      // Draw a dashed vertical line
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = transmitMode ? 'rgba(0, 255, 0, 0.4)' : 'rgba(255, 255, 255, 0.4)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height - 20);
      ctx.stroke();
      ctx.setLineDash([]); // Reset dash
      
      // Adjust text alignment based on position
      if (normalizedPos < 0.05) {
        ctx.textAlign = 'left';
      } else if (normalizedPos > 0.95) {
        ctx.textAlign = 'right';
      } else {
        ctx.textAlign = 'center';
      }
      
      // Draw the label
      ctx.fillText(marker.label, x, 10);
    });
    
  }, [frequencies, transmitMode]);
  
  return (
    <div className="frequency-visualizer">
      <canvas 
        ref={canvasRef} 
        width={800} 
        height={175} // Slightly increased height to ensure all labels are visible
        className={transmitMode ? 'transmit-active' : ''}
      />
    </div>
  );
};

export default FrequencyVisualizer; 