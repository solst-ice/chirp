// Entry for /explain/: the "how it works" article on a page of its own, so its
// sound demos never share a page with the app's microphone or transmitter.
import React from 'react'
import ReactDOM from 'react-dom/client'
import Explainer from './explainer/Explainer'
import './index.css'
import './App.css'

const rootElement = document.getElementById('root')
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <div className="ex-page">
        <Explainer />
      </div>
    </React.StrictMode>,
  )
}
