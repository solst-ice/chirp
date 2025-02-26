import React from 'react';
import App from './App.tsx';

// This is a redirection component to ensure we load the correct App
console.log('Using App.jsx as a bridge to load App.tsx');

export default function AppBridge() {
  return <App />;
}
