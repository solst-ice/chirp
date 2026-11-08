import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './App.css'
import { applyTheme, initialTheme } from './theme'

// Before the first render, so the page never flashes the other theme.
applyTheme(initialTheme())

// Find the root element and render our App
const rootElement = document.getElementById('root')
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
} 