import React from 'react';

interface FrequencyVisualizerProps {
  frequencies: number[];
}

const FrequencyVisualizer: React.FC<FrequencyVisualizerProps> = ({ frequencies }) => {
  return (
    <div className="frequency-visualizer">
      {frequencies.map((value, index) => (
        <div
          key={index}
          className="frequency-bar"
          style={{
            height: `${Math.min(value, 150)}px`,
          }}
        />
      ))}
    </div>
  );
};

export default FrequencyVisualizer; 